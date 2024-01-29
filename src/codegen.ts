import {createRenderer, Code, indent, CodeLine} from "./code-node";
import {CodeGeneratorRequest, CodeGeneratorResponse} from "./google/protobuf/compiler/plugin.proto.gen";
import {MethodDescriptorProto, ServiceDescriptorProto, FieldDescriptorProto, FileDescriptorProto} from "./google/protobuf/descriptor.proto.gen";
import {pascalCase, camelCase} from "change-case";
import { MessageDef, EnumDef, FieldDef, toEnumDefs, toMessageDefs, parseCommentFlags, getSurrogates, buildDeclarationsMap, ImportContext, FileContext, getFileContext } from "./preprocess";
import { protoNameJoin, nsRelative, importNameFor } from "./names";
import { relativeImportPath, protoPathToTsImportPath } from "./paths";
import { fieldTypeInfo, FieldTypeInfo, protoMessageTypeToJs, nameOfBuiltInType, ProtoTypeNameToTsTranslator } from "./proto-field-types";

export function runPlugin(request: CodeGeneratorRequest.Strict): CodeGeneratorResponse.Loose {
    const outFiles: CodeGeneratorResponse.File.Value[] = [];

    const paramString = request.parameter;
    const parameters = paramString
        .split(/,/)
        .map(kv => kv.split(/=/, 2))
        .reduce((a, v) => { a.set(v[0], v[1] || ""); return a; }, new Map<string, string>());

    const protoFileList = request.protoFiles;

    const genJson = parameters.get("json") !== undefined;

    // handle surrogates
    const surrogates = getSurrogates(protoFileList);
    
    // build a map of identifiers to the files that define them
    // because to import these we need to import to a variable
    // and then use that variable to access the external identifier
    // so we need to know which imported file declared the identifier we're using
    const imports = buildDeclarationsMap(protoFileList);

    const render = createRenderer();

    for (const infile of request.protoFiles) {
        const inName = infile.name;
        
        const name = `${inName}.gen.ts`;
        const code = renderProtoFile(infile, imports, surrogates);
        const content = render(code);
        outFiles.push({name, content});

        if (genJson) {
            // Dump out some helpful json
            outFiles.push({
                name: `${inName}.gen.json`,
                content: JSON.stringify(infile, null, 4),
            })
        }
    }

    return {
        files: outFiles,
        supportedFeatures: CodeGeneratorResponse.Feature.Proto3Optional.toNumber(),
    };
}

function enumValToJsName(enumName: string, valName: string): string {
    const pascalName = pascalCase(valName);
    const prefix = pascalCase(enumName);
    return pascalName?.startsWith(prefix) ? pascalName.slice(prefix.length) : pascalName;
}

type EnumValueInfo = {
    jsName: string,
    number: number,
}

function getEnumValues(enumJsName: string, e: EnumDef): EnumValueInfo[] {
    const values = e.values.map(v => ({
        jsName: enumValToJsName(enumJsName || "", v.name || ""),
        number: v.number!,
    }))
    // add a 0 if there isn't one already
    // this is the current strategy to handle the situation where we are importing from a proto2 as is the case with descriptor.proto
    return values.some(v => v.number === 0) ? values : [{jsName: "Unspecified", number: 0}, ...values];
}

function renderEnumTypeDecl(e: EnumDef, ns: string | undefined): Code {
    const enumJsName = e.name || "";
    const values = getEnumValues(enumJsName, e);
    return [
        ``,
        `export declare namespace ${enumJsName} {`,
        indent(
            `export type ProtoName = "${protoNameJoin(ns, e.name)}"`,
            `export type Def = {`,
            indent(
                values.map(({jsName, number}) => ([
                    `"${jsName}": ${number},`,
                ]))
            ),
            `}`,
            ``,
            values.map(({jsName}) => `export type ${jsName} = E.Value<ProtoName, Def, "${jsName}">`),
            ``,
            `export type Strict = E.EnumValue<ProtoName, E.Literal<Def>>;`,
            `export type Value = Strict | E.Literal<Def>;`,
        ),
        `}`,
        `export type ${enumJsName} = ${enumJsName}.Strict;`,
    ];
}

function renderEnumDef(e: EnumDef, context: Context): Code {
    const enumJsName = e.name || "";
    const values = getEnumValues(enumJsName, e);
    const relname = nsRelative(e.fqName, context.name);
    return [
        ``,
        `E.define(${relname}, {`,
        indent(
            values.map(({jsName, number}) => ([
                `"${jsName}": ${number} as ${number},`,
            ]))
        ),
        `});`,
    ];
}


type MapType = {
    name: string,
    key: FieldDef,
    value: FieldDef,
}

type Context = {
    readonly imports: ImportContext,
    readonly surrogates: ReadonlyMap<string, string>,
    readonly file: FileContext,
    readonly name: string | undefined,
    lookupType(name: string): MessageDef | EnumDef | undefined,
}

function isRepeatedField(field: FieldDef): boolean {
    return field.label == FieldDescriptorProto.Label.Repeated;
}

function getMapType(field: FieldDef, lookupMapType: (typename: string) => MapType | undefined) {
    return lookupMapType(field.typeName!);
}

function tsField(protoTypeName: string, protoFieldName: string, protoFieldNumber: number, jsFieldName: string, jsTypeName: string, optional: boolean) {
    return [
        `// ${protoTypeName} ${protoFieldName} = ${protoFieldNumber};`,
        `readonly ${jsFieldName}${(optional ? "?" : "")}: ${jsTypeName},`,
    ]
}

function renderMessageFieldTypeDecl(strict: boolean, field: FieldDef, context: Context, lookupMapType: (typename: string) => MapType | undefined) {
    const protoFieldName = field.name!;
    const jsFieldName = `${camelCase(protoFieldName)}`;
    const protoFieldNumber = field.number!;
    const type = fieldTypeInfo(field);
    const mapType = getMapType(field, lookupMapType);
    const isRepeated = !mapType && isRepeatedField(field);
    const isOptional = field.proto3Optional;
    const optional = !strict || isOptional;
    if (mapType) {
        const valtype = fieldTypeInfo(mapType.value);
        const keytype = fieldTypeInfo(mapType.key);
        if (!keytype.builtin)
            throw new Error(`Illegal map key type ${keytype.proto}`);
        const protoValTypeRelative = mapType.value.typeName === "" ? valtype.proto : nsRelative(mapType.value.typeName, context.name);
        const protoKeyType = keytype.proto;
        const protoTypeName = `map<${protoKeyType}, ${protoValTypeRelative}>`;
        const jsValTypeName = valtype.builtin ? (strict ? valtype.strict : valtype.loose) : jsIdentifierForProtoType(valtype, context, strict);
        const jsStrictMap = `{ ${(keytype.proto === "bool" ? `[key in "true" | "false"]?` : `[key: string]`)}: ${jsValTypeName} }`;
        const jsLooseMap = `Map<${keytype.loose}, ${jsValTypeName}> | ${jsStrictMap}`
        const jsTypeName = strict ? jsStrictMap : jsLooseMap;
        return tsField(protoTypeName, protoFieldName, protoFieldNumber, jsFieldName, jsTypeName, optional);
    }
    else {
        const protoRelative = field.typeName === "" ? type.proto : nsRelative(field.typeName, context.name)
        const protoTypeName = `${(isOptional ? "optional " : "")}${(isRepeated ? "repeated " : "")}${protoRelative}`;
        const jsElementTypeName = type.builtin ? (strict ? type.strict : type.loose) : jsIdentifierForProtoType(type, context, strict);
        const isSurrogate = context.surrogates.has(type.proto);
        const jsTypeName = `${jsElementTypeName}${isRepeated ? '[]' : (!type.builtin && type.nullable && strict && !isSurrogate) ? ' | undefined' : ''}`
        return tsField(protoTypeName, protoFieldName, protoFieldNumber, jsFieldName, jsTypeName, optional);
    }
}

function renderOneofFieldTypeDecl(strict: boolean, oneofName: string, field: FieldDef, context: Context) {
    const protoFieldName = field.name!;
    const jsFieldName = `${camelCase(protoFieldName)}`;
    const type = fieldTypeInfo(field);
    const protoRelative = field.typeName === "" ? type.proto : nsRelative(field.typeName, context.name);
    const protoTypeName = `${protoRelative}`;
    const surrogate = context.surrogates.get(type.proto);
    const jsElementTypeName = type.builtin ? (strict ? type.strict : type.loose) : (jsIdentifierForProtoType(type, context, strict));
    const isSurrogate = context.surrogates.has(type.proto);
    const jsTypeName = `${jsElementTypeName}${(!type.builtin && type.nullable && strict && !isSurrogate) ? ' | undefined' : !strict ? ' | undefined' : ''}`
    const caseDecl = strict ? `readonly type: "${jsFieldName}", ` : `readonly type?: "${jsFieldName}", `;
    return [
        `// ${protoTypeName} ${protoFieldName} = ${field.number};`,
        `| { ${caseDecl}readonly ${jsFieldName}: ${jsTypeName} }`,
    ]    
}

function renderOneofTypeDecl(strict: boolean, oneof: OneofInfo, context: Context) {
    const caseDecl = strict ? `undefined` : `undefined | {}`;
    return [
        ``,
        `type ${pascalCase(oneof.name)}${strict ? "Strict" : "Loose"} = ${caseDecl}`,
        indent(
            oneof.fields.map(field => renderOneofFieldTypeDecl(strict, oneof.name, field, context))
        ),
    ]    
}

function fieldWriteExpr(writer: string, expression: string, protoFieldNumber: number, ...args: string[]): Code {
    return `${writer}(w, ${args.map(a => `${a}, `).join("")}${expression}, ${protoFieldNumber})`
}

function getTypeWriter(type: FieldTypeInfo, context: Context, representationVariation: string | undefined): string {
    return type.builtin ? (type.presence === "optional" ? `W.optional${pascalCase(nameOfBuiltInType(type, representationVariation))}` : `W.${nameOfBuiltInType(type, representationVariation)}`) : `${jsIdentifierForProtoType(type, context)}.write`
}

function getTypeReader(type: FieldTypeInfo, context: Context, representationVariation: string | undefined): string {
    return type.builtin ? (type.presence === "optional" ? `F.optional${pascalCase(nameOfBuiltInType(type, representationVariation))}` : `F.${nameOfBuiltInType(type, representationVariation)}`) : `() => ${jsIdentifierForProtoType(type, context)}`
}

function getRepresentationVariation(path: string, comments: ReadonlyMap<string, string>): string | undefined {
    const comment = comments.get(path);
    if (!comment)
        return undefined;
    const flags = parseCommentFlags(comment);
    const flag = flags.find(f => f.name === "representation");
    return flag?.args;
}

export function jsIdentifierForProtoType(type: FieldTypeInfo, context: Context, strict?: boolean) {
    if (type.builtin)
        return type.proto;
    return jsIdentifierForCustomType(type.proto, type.toJsType, context, strict);
}

export function jsIdentifierForCustomType(protoType: string, toJsType: ProtoTypeNameToTsTranslator, {imports, surrogates, file, name}: Context, strict?: boolean) {
    const importContext = imports.get(protoType);
    const surrogate = surrogates.get(protoType);
    if (surrogate) {
        return (
            strict === true ? `ReturnType<typeof Surrogates.${surrogate}.readValue>` :
            strict === false ? `Parameters<typeof Surrogates.${surrogate}.writeValue>[1]` :
            `Surrogates.${surrogate}`
        )
    }
    // is the identifier in the current file?
    if (!importContext || importContext.path === file.path)
        return toJsType(nsRelative(protoType, name), strict);
    // the identifier was imported so we need an import reference
    return `${importNameFor(importContext.path)}.${toJsType(nsRelative(protoType, importContext.pkg || ""), strict)}`;
}

function renderMessageFieldWriteIfPresent(field: FieldDef, context: Context, lookupMapType: (typename: string) => MapType | undefined): Code {
    const protoFieldName = field.name!;
    const jsFieldName = `${camelCase(protoFieldName)}`;
    return `if ('${jsFieldName}' in msg) { ${renderMessageFieldWrite(field, context, lookupMapType)}; }`
}

function renderMessageFieldWrite(field: FieldDef, context: Context, lookupMapType: (typename: string) => MapType | undefined, varName: string = "msg"): Code {
    const protoFieldName = field.name!;
    const jsFieldName = `${camelCase(protoFieldName)}`;
    const protoFieldNumber = field.number!;
    const type = fieldTypeInfo(field);
    const mapType = getMapType(field, lookupMapType);
    const isRepeated = !mapType && isRepeatedField(field);
    const representationVariation = getRepresentationVariation(field.path, context.file.comments);
    if (mapType) {
        const valtype = fieldTypeInfo(mapType.value);
        const keytype = fieldTypeInfo(mapType.key);
        const valwriter = getTypeWriter(valtype, context, representationVariation);
        if (!keytype.builtin)
            throw new Error(`Illegal map key type ${keytype.proto}`);
        const keyTypeName = nameOfBuiltInType(keytype, representationVariation);
        return fieldWriteExpr(`W.map`, `${varName}.${jsFieldName}`, protoFieldNumber, `W.${keyTypeName}`, `KC.${keyTypeName}`, valwriter);
    }
    const valueWriter = getTypeWriter(type, context, representationVariation);
    if (isRepeated) {
        return fieldWriteExpr(`W.${type.packed ? "packed" : "repeated"}`, `${varName}.${jsFieldName}`, protoFieldNumber, valueWriter);
    }
    else {
        return fieldWriteExpr(valueWriter, `${varName}.${jsFieldName}`, protoFieldNumber);
    }
}

function renderOneofFieldsWrite(oneof: OneofInfo, context: Context) {
    return [
        `if ("${oneof.name}" in msg) {`,
        indent([
            `const value = msg.${oneof.name};`,
            oneof.fields.map((field, index) => renderOneofFieldWrite(field, index, context)),
        ]),
        `}`,
    ];
}

function renderOneofFieldWrite(field: FieldDef, index: number, context: Context) {
    // TODO: the code generated by this might be inefficient for large oneofs; consider and benchmark other methods for large oneofs
    const protoFieldName = field.name!;
    const jsFieldName = `${camelCase(protoFieldName)}`;
    return `${(index === 0) ? "if" : "else if"} ("${jsFieldName}" in value) { ${renderMessageFieldWrite(field, context, () => undefined, "value")}; }`
}

function renderMessageFieldRead(field: FieldDef, context: Context, lookupMapType: (typename: string) => MapType | undefined, lookupOneofName: (index: number) => string | undefined) {
    const protoFieldName = field.name!;
    const jsFieldName = `${camelCase(protoFieldName)}`;
    const protoFieldNumber = field.number!;
    const type = fieldTypeInfo(field);
    const map = getMapType(field, lookupMapType);
    const oneof = field.oneofIndex !== undefined && !field.proto3Optional ? lookupOneofName(field.oneofIndex) : undefined;
    const isRepeated = !map && isRepeatedField(field);
    const representationVariation = getRepresentationVariation(field.path, context.file.comments);
    if (map) {
        const valtype = fieldTypeInfo(map.value);
        const keytype = fieldTypeInfo(map.key);
        const valueReader = getTypeReader(valtype, context, representationVariation);
        const keyReader = getTypeReader(keytype, context, representationVariation);
        return `[${protoFieldNumber}, "${jsFieldName}", F.map(${keyReader}, ${valueReader})],`;
    }
    else {
        const valueReader = getTypeReader(type, context, representationVariation);
        const reader = oneof ? `F.oneof("${oneof}", ${valueReader})` : isRepeated ? `F.repeated(${valueReader})` : valueReader;
        return `[${protoFieldNumber}, "${jsFieldName}", ${reader}],`
    }
}

function renderTypeDecls(enums: readonly EnumDef[], messages: readonly MessageDef[], context: Context): Code {
    return [
        enums.map((e, i) => renderEnumTypeDecl(e, context.name)),
        messages.map((m, i) => renderMessageTypeDecl(m, {...context, name: `${protoNameJoin(context.name, m.name || "")}`})),
    ]
}

interface OneofInfo {
    name: string,
    index: number,
    fields: FieldDef[],
}

function flatten(types: readonly (MessageDef | EnumDef)[]): readonly (MessageDef | EnumDef)[] {
    if (types.length == 0)
        return [];
    return types.flatMap(t => {
        if (t.type === "enum") {
            return [t];
        }
        else {
            const {nestedTypes: nestedTypeList, enumTypes: enumTypeList} = t;
            return [t, ...enumTypeList, ...flatten(nestedTypeList)];
        }
    })
}

function renderTypeDef(t: MessageDef | EnumDef, context: Context) {
    return t.type === "message" ? renderMessageDefine(t, context) : renderEnumDef(t, context)
}

function renderTypeDefines(t: (MessageDef | EnumDef)[], context: Context) {
    const flattened = flatten(t);
    return flattened.map(nt => renderTypeDef(nt, context));
}

function renderMessageDefine(m: MessageDef, context: Context): Code {
    const mapTypes = m.mapTypes
        .map<MapType>(nt => ({
            name: nt.fqName,
            key: nt.fields.find(kf => kf.number === 1)!,
            value: nt.fields.find(vf => vf.number === 2)!,
        }))
    const fields = m.fields.map<FieldDef>((field, i) => ({...field, path: `${m.path}/2/${i}`}));
    const oneofs = m.oneofDecls
        .map(odl => odl.name!)
        .map<OneofInfo>((name, index) => ({
            name,
            index,
            fields: fields.filter(f => f.oneofIndex === index)
        }))
    const getMapType = (name: string) => mapTypes.find(mt => name === mt.name);
    const getOneofName = (index: number) => oneofs[index]?.name;
    const nonOneOfFields = fields
        .filter(f => f.oneofIndex === undefined)
        //.map(f => fieldDef(f, fqName, ))
    const relname = nsRelative(m.fqName, context.name);
    return [
        ``,
        `M.define(${relname}, {`,
        indent([
            `writeContents: (w, msg) => {`,
            indent([
                nonOneOfFields
                .map(field => renderMessageFieldWriteIfPresent(field, context, getMapType)),
            ]),
            indent([
                oneofs
                .map(oneof => renderOneofFieldsWrite(oneof, context))
            ]),
            `},`,
            `fields: [`,
            indent([
                fields
                .map(field => renderMessageFieldRead(field, context, getMapType, getOneofName)),
            ]),
            `],`,
        ]),
        `})`,
    ];
}

function renderProperty(name: string, code: Code): Code {
    const frag = typeof code === "string" ? [code] : code;
    return (
        frag.length === 0 ? [] :
        frag.length === 1 ? [`${name}: ${frag[0]},`] :
        [`${name}: ${frag[0]}`, ...frag.slice(1, frag.length - 1), `${frag[frag.length - 1]},`]
    )
}

function renderPlaceholderType(t: EnumDef | MessageDef, context: Context, top: boolean): Code {
    return t.type === "message" ? renderMessagePlaceholderType(t, context, top) : renderEnumPlaceholderType(t, context, top)
}

function renderEnumPlaceholderType(e: EnumDef, context: Context, top: boolean): Code {
    const relname = nsRelative(e.fqName, context.name);
    const typeDef = [`E.EnumDef<${relname}.ProtoName, ${relname}.Def>`];
    return top ? typeDef : renderProperty(e.name!, typeDef);
}

function renderMessagePlaceholderType(m: MessageDef, context: Context, top: boolean): Code {
    const relname = nsRelative(m.fqName, context.name);
    const thisMsg = `M.MessageDef<${relname}.Strict, ${relname}.Value>`;
    const nestedTypes = [...m.enumTypes, ...m.nestedTypes];

    const typeDef = (nestedTypes.length === 0)
        ? [thisMsg]
        : [
            `${thisMsg} & {`,
            indent([
                nestedTypes.map(nt => renderPlaceholderType(nt, context, false))
            ]),
            `}`,
        ]
    
    return top ? typeDef : renderProperty(m.name!, typeDef);
}

function renderPlaceholders(types: (EnumDef | MessageDef)[], context: Context, top: boolean): Code {
    return types.map(t => renderPlaceholder(t, context, top));
}

function renderPlaceholder(t: EnumDef | MessageDef, context: Context, top: boolean): Code {
    const nestedTypes = t.type === "enum" ? [] :
        [...t.enumTypes, ...t.nestedTypes];
    
    const nestedPlaceholders = renderPlaceholders(nestedTypes, context, false);

    return top
        ? [
            ``,
            `export const ${t.name} = {`,
            indent(nestedPlaceholders),
            `} as unknown as`,
            indent(renderPlaceholderType(t, context, top)),
        ]
        : nestedPlaceholders.length === 0 ? [`${t.name}: {},`] : [
            `${t.name}: {`,
            indent(nestedPlaceholders),
            `},`,
        ]
}

function renderMessageTypeDecl(m: MessageDef, context: Context): Code {
    const nestedEnums = m.enumTypes.map<EnumDef>((nested, i) => ({...nested, path: `${m.path}/4/${i}`}));
    const mapTypes = m.mapTypes
        .map<MapType>(nt => ({
            name: nt.fqName,
            key: nt.fields.find(kf => kf.number === 1)!,
            value: nt.fields.find(vf => vf.number === 2)!,
        }))
    const fields = m.fields.map<FieldDef>((field, i) => ({...field, path: `${m.path}/2/${i}`}));
    const oneofs = m.oneofDecls
        .map(odl => odl.name!)
        .map<OneofInfo>((name, index) => ({
            name,
            index,
            fields: fields.filter(f => f.oneofIndex === index)
        }))
    const getMapType = (name: string) => mapTypes.find(mt => name === mt.name);
    const getOneofName = (index: number) => oneofs[index]?.name;
    const nonOneOfFields = fields
        .filter(f => f.oneofIndex === undefined)
    const nestedMessages = m.nestedTypes;

    return [
        ``,
        `export declare namespace ${m.name} {`,
        indent([
            `export type ProtoName = "${context.name}";`,
            oneofs.map(oneof => renderOneofTypeDecl(true, oneof, context)),
            ``,
            `export type Strict = {`,
            indent([
                nonOneOfFields
                    .map(field => renderMessageFieldTypeDecl(true, field, context, getMapType)),
                oneofs
                    .map(oo => [
                        `// oneof ${oo.name}`,
                        `readonly ${oo.name}: ${pascalCase(oo.name)}Strict,`,
                    ])
            ]),
            `}`,
            oneofs.map(oneof => renderOneofTypeDecl(false, oneof, context)),
            ``,
            `export type Loose = {`,
            indent([
                nonOneOfFields
                    .map(field => renderMessageFieldTypeDecl(false, field, context, getMapType)),
                oneofs
                    .map(oo => [
                        `// oneof ${oo.name}`,
                        `readonly ${oo.name}?: ${pascalCase(oo.name)}Loose,`,
                    ])
            ]),
            `}`,
            ``,
            `export type Value = Strict | Loose;`,
            renderTypeDecls(nestedEnums, nestedMessages, context),
        ]),
        `}`,
    ]
}

function renderDependencyImport(depPath: string, fromProtoPath: string): CodeLine[] {
    if (depPath === 'google/protobuf/wrappers.proto')
        return [];
    if (depPath === 'google/protobuf/duration.proto' || depPath === 'google/protobuf/timestamp.proto')
        return [`import * as timelib from '@js-joda/core';`];
    const relPath = relativeImportPath(depPath, fromProtoPath);
    return [`import * as ${importNameFor(depPath)} from "${protoPathToTsImportPath(relPath)}";`]
}

function getMethodType(clientStreaming: boolean, serverStreaming: boolean): "unary" | "client-streaming" | "server-streaming" | "bidirectional" {
    return clientStreaming ? (serverStreaming ? "bidirectional" : "client-streaming") : (serverStreaming ? "server-streaming" : "unary");
}

function getMethodInfo(method: MethodDescriptorProto.Strict, context: Context) {
    const methodName = method.name;
    const requestJsName = jsIdentifierForCustomType(method.inputType, protoMessageTypeToJs, context);
    const responseJsName = jsIdentifierForCustomType(method.outputType, protoMessageTypeToJs, context);
    const [reducer, reducerOutput] = detectMethodReducer(method, context);
    return {methodName, requestJsName, responseJsName, reducer, reducerOutput};
}

function renderUnaryMethod(serviceName: string, method: MethodDescriptorProto.Strict, context: Context): Code {
    const {methodName, requestJsName, responseJsName} = getMethodInfo(method, context);
    return [
        `${pascalCase(methodName)}: S.unary(${serviceName}Service, "${methodName}", ${requestJsName}.encode, ${responseJsName}.decode),`,
    ]
}

function renderServerStreamingMethod(serviceName: string, method: MethodDescriptorProto.Strict, context: Context): Code {
    const {methodName, requestJsName, responseJsName, reducer, reducerOutput} = getMethodInfo(method, context);
    return [
        `${pascalCase(methodName)}: S.serverStreaming(${serviceName}Service, "${methodName}", ${requestJsName}.encode, ${responseJsName}.decode, () => Reducers.${reducer}<${responseJsName}.Strict>()),`,
    ]
}

function renderMethod(serviceName: string, method: MethodDescriptorProto.Strict, context: Context): Code {
    const type = getMethodType(method.clientStreaming || false, method.serverStreaming || false);
    switch (type) {
        case "unary":
            return renderUnaryMethod(serviceName, method, context);
        case "server-streaming":
            return renderServerStreamingMethod(serviceName, method, context);
        default:
            // nothing else is currently supported by the grpc-web protocol
            return []
    }
}

function detectMethodReducer(method: MethodDescriptorProto.Strict, context: Context): ["keepLast" | "keepAll" | "keepLastByKey" | string, string] {
    /*
    // TODO: get comment flags for the method
    const comment = method.comment;
    if (comment) {
        const commentFlags = getCommentFlags(comment);
        const reducerFlag = commentFlags.find(cf => cf.name === "reducer");
        if (reducerFlag && "args" in reducerFlag && reducerFlag.args) {
            return reducerFlag.args;
        }
    }
    */
    if (method.serverStreaming) {
        const resultType = method.outputType;
        const type = context.lookupType(resultType);
        if (type && type.type === "message") {
            const is_subscription = type.fields.some(f => f.name === "subscription_state");
            if (is_subscription) {
                const records = type.fields.find(f => f.name === "records");
                if (records) {
                    const recordsTypeName = records.typeName;
                    const recordsType = recordsTypeName && context.lookupType(recordsTypeName);
                    if (recordsType && recordsType.type === "message" && recordsType.fields.length >= 2) {
                        const keyField = recordsType.fields.find(f => f.name === "key");
                        if (keyField) {
                            return ["keepLastByKey", recordsType.name!];
                        }
                    }
                }
            }
        }
    }
    return ["keepAll", `${method.outputType}[]`];
}

function renderService(svc: ServiceDescriptorProto.Strict, context: Context) {
    const serviceFqName = protoNameJoin(context.name, svc.name);
    return [
        ``,
        `const ${svc.name}Service: S.GrpcService = {name: "${serviceFqName}"}`,
        ``,
        `export const ${svc.name} = {`,
        indent([
            svc.methods.map(method => renderMethod(svc.name, method, context)),
        ]),
        `}`,
    ];
}

function findType(enums: readonly EnumDef[], messages: readonly MessageDef[], fqName: string): EnumDef | MessageDef | undefined {
    for (const e of enums) {
        if (e.fqName === fqName)
            return e;
    }
    for (const m of messages) {
        if (m.fqName === fqName)
            return m;
        const inNested = findType(m.enumTypes, m.nestedTypes, fqName);
        if (inNested)
            return inNested;
    }
    return undefined;
}

function unique(lines: CodeLine[]) {
    return lines.filter((v, i, a) => a.indexOf(v) === i);
}

function renderProtoFile(infile: FileDescriptorProto.Strict, imports: ImportContext, surrogates: ReadonlyMap<string, string>): Code {
    const fileContext: FileContext = getFileContext(infile);
    const enums = toEnumDefs(fileContext.pkg, infile.enumTypes, "", 5, fileContext.comments);
    const messages = toMessageDefs(fileContext.pkg, infile.messageTypes, "", 4, fileContext.comments);
    const lookupType = (fqName: string) => findType(enums, messages, fqName);
    const context: Context = {imports, surrogates, file: fileContext, name: fileContext.pkg, lookupType}
    const depth = infile.name.split(/\//)?.length! - 1;
    const pathToRoot = depth === 0 ? "." : Array.apply(null, Array(depth)).map(_ => "..").join("/");
    return [
        `/* istanbul ignore file */`,
        `/**`,
        ` * @fileoverview tsgrpc-generated client stub for ${fileContext.pkg} from ${fileContext.path}`,
        ` * @enhanceable`,
        ` * @public`,
        ` */`,
        ``,
        `// GENERATED CODE -- DO NOT EDIT!`,
        ``,
        `/* eslint-disable */`,
        `// @ts-nocheck`,
        ``,
        `import {Enums as E, Messages as M, Services as S, WriteField as W, KeyConverters as KC, Helpers as H, Reader, FieldTypes as F, Reducers, Types as T} from "tsprotobuf-codec";`,
        unique(infile.dependencies.map(d => renderDependencyImport(d, fileContext.path)).flat()),
        surrogates.size ? [`import * as Surrogates from "${pathToRoot}/surrogates";`] : [],
        renderPlaceholders([...enums, ...messages], context, true),
        renderTypeDecls(enums, messages, context),
        renderTypeDefines([...enums, ...messages], context),
        infile.services.map(svc => renderService(svc, context)),
    ]
}
