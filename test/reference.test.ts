import {Inner, Outer, EnumType, ResultEvent, ServiceOne } from "./reference/example.proto.gen"
import {Services} from "tsprotobuf-codec"

const hexOf: (buffer: number[] | ArrayBuffer) => string = (buffer) =>
Array.from(new Uint8Array(buffer))
    .map((b: number) => b.toString(16).padStart(2, "0"))
    .join("")

const fromHex: (hex: string) => Uint8Array = (hex) => {
    const length = hex.length / 2;
    const array = new Uint8Array(length);
    for (let i = 0; i < length; i++)
        array[i] = parseInt(hex.substr(i * 2, 2), 16);
    return array;
}

describe("meta test hexOf <-> fromHex", () => {
    it('converts to/from empty', () => {
        expect(fromHex("")).toEqual(Uint8Array.from([]));
        expect(hexOf([])).toBe("");
    })

    it('converts to/from non-empty', () => {
        expect(fromHex("012345")).toEqual(Uint8Array.from([0x1, 0x23, 0x45]));
        expect(hexOf([0x1, 0x23, 0x45])).toBe("012345");
    })
})

test.todo("make sure generated ts passes type checking")

test.todo("make sure typescript code that references the generated ts passes and fails type check when appropriate")

describe("Special enum encoding", () => {
    test('encode outer with enum works', () => {
        const encoded = Outer.encode({enumVal: EnumType.One});
        expect(hexOf(encoded)).toBe("6001");
    })
    
    test('encode outer with invalid numeric enum throws', () => {
        expect(() => Outer.encode({doubleVal: 1, enumVal: 3 as any}))
            .toThrow(/invalid/i);
    })
    
    test('EnumType toString()', () => {
        const actual = EnumType.toString(2);
        expect(actual).toBe("Two");
    })
    
    test('EnumType toString(undefined)', () => {
        const actual = EnumType.toString(undefined);
        expect(actual).toBeUndefined();
    })
    
    test('EnumType toJson()', () => {
        const stringified = JSON.stringify({e: EnumType.from(2)});
        expect(stringified).toBe(`{"e":"Two"}`);
    })

    test('encode outer with string enum works', () => {
        const encoded = Outer.encode({enumVal: "Two"});
        expect(hexOf(encoded)).toBe("6002");
    })

    test('encode repeated enum works', () => {
        const encoded = Outer.Nested.encode({enums: ["Red", "Black", "Blue"]});
        expect(hexOf(encoded)).toBe("0a03010002");
    })

    test('encode missing repeated enum works', () => {
        const encoded = Outer.Nested.encode({});
        expect(hexOf(encoded)).toBe("");
    })
})

describe("Reference encoding", () => {
    test('encode inner works', () => {
        const encoded = Inner.encode({zigzagLong: "12345678901"});
        expect(hexOf(encoded)).toBe("8001eaf0e0fd5b");
    })

    test('encode empty inner works', () => {
        const encoded = Inner.encode({});
        expect(hexOf(encoded)).toBe("");
    })

    test('encode outer with numeric enum works', () => {
        const encoded = Outer.encode({enumVal: 2});
        expect(hexOf(encoded)).toBe("6002");
    })

    test('encode outer with inner works', () => {
        const encoded = Outer.encode({inner: {zigzagLong: "12345678901"}});
        expect(hexOf(encoded)).toBe("8a01078001eaf0e0fd5b");
    })

    test('encode outer within outer works', () => {
        const encoded = Outer.encode({doubleVal: 1, recursive: {doubleVal: 2}});
        expect(hexOf(encoded)).toBe("09000000000000f03fc20109090000000000000040");
    })

    test('encode "ResultEvent" works', () => {
        const encoded = ResultEvent.encode({subscriptionState: "One", records: [{key: "one", value: "uno"}]});
        expect(hexOf(encoded)).toBe("0801120a0a036f6e651203756e6f");
    })

    test('encode repeated scalar', () => {
        const encoded = Outer.encode({doubles: [1, 0, 3]});
        expect(hexOf(encoded)).toBe("920118000000000000f03f00000000000000000000000000000840");
    })

    test('encode repeated message', () => {
        const encoded = Outer.encode({inners: [{zigzagInt: 1}, {}, {zigzagInt: 2}]});
        expect(hexOf(encoded)).toBe("9a010278029a01009a01027804");
    })

    test('encode nested message from inside', () => {
        const encoded = Outer.encode({nested: {enums: ["Red"]}});
        expect(hexOf(encoded)).toBe("da01030a0101");
    })

    test('encode nested message from outside', () => {
        const encoded = Inner.encode({nested: {enums: ["Red"]}});
        expect(hexOf(encoded)).toBe("8a01030a0101");
    })

    test('encode imported message', () => {
        const encoded = Outer.encode({imported: {value: "hi"}});
        expect(hexOf(encoded)).toBe(`e201040a026869`);
    })

    test('encode recursive message', () => {
        const encoded = Outer.encode({recursive: {doubleVal: 1}});
        expect(hexOf(encoded)).toBe("c2010909000000000000f03f");
    })

    test('encode indirect recursive message', () => {
        const encoded = Inner.encode({nested: {inner: {zigzagLong: 1}}});
        expect(hexOf(encoded)).toBe("8a01051203800102");
    })

    test('encode outer with inner in oneof works', () => {
        const encoded = Outer.encode({union: {innerOption: {zigzagLong: "12345678901"}}});
        expect(hexOf(encoded)).toBe("ca01078001eaf0e0fd5b");
    })

    test('encode hexpad field', () => {
        const encoded = Outer.encode({ulongFixedHex: "00000000deadbeef"});
        expect(hexOf(encoded)).toBe("f901efbeadde00000000");
    })

    test('encode surrogate field', () => {
        const encoded = Outer.encode({surrogate: "(valid)"});
        expect(hexOf(encoded)).toBe("8202070a0576616c6964");
    })

    test('encode nothing when surrogate is default value', () => {
        const encoded = Outer.encode({surrogate: "default"});
        expect(hexOf(encoded)).toBe("");
    })

    test('encode invalid surrogate field', () => {
        const encoded = Outer.encode({surrogate: "invalid"});
        // encodes as {value: `** bad format: "invalid" **`}
        expect(hexOf(encoded)).toBe("82021d0a1b2a2a2062616420666f726d61743a2022696e76616c696422202a2a");
    })

    test('encode undefined maybe field', () => {
        const encoded = Outer.encode({maybeInt32: undefined});
        expect(hexOf(encoded)).toBe("");
    })

    test('encode maybe field with primitive default', () => {
        const encoded = Outer.encode({maybeInt32: 0});
        expect(hexOf(encoded)).toBe("aa0200");
    })

    test('encode maybe field with primitive value', () => {
        const encoded = Outer.encode({maybeInt32: 10});
        expect(hexOf(encoded)).toBe("aa0202080a");
    })

    test('encode optional field with primitive value', () => {
        const encoded = Outer.encode({optionalInt32: 10});
        expect(hexOf(encoded)).toBe("e0020a");
    })

    test('encode optional field with default value', () => {
        const encoded = Outer.encode({optionalInt32: 0});
        expect(hexOf(encoded)).toBe("e00200");
    })

    test('encode many fields', () => {
        const encoded = Outer.encode({
            doubleVal: 1,
            floatVal: 1,
            longVal: 1,
            ulongVal: 1,
            intVal: 1,
            ulongFixed: 1,
            uintFixed: 1,
            boolVal: true,
            stringVal: "1",
            bytesVal: new Uint8Array([1]),
            uintVal: 1,
            enumVal: 1,
            inner: {
                intFixed: 1,
                longFixed: 1,
                zigzagInt: 1,
                zigzagLong: 1,
            },
            doubles: [1],
            inners: [{
                intFixed: 2,
                longFixed: 2,
                zigzagInt: 2,
                zigzagLong: 2,
            }],
            map: {"one": "uno"},
            mapInner: {
                "inner": {
                    intFixed: 3,
                    longFixed: 3,
                    zigzagInt: 3,
                    zigzagLong: 3,
                }
            },
            mapInts: { 1: 2 },
            mapBool: { true: "yep" },
            recursive: {
                doubleVal: 1,
            },
            union: {stringOption: "string"},
            ulongFixedHex: "00000000deadbeef",
            maybeInt32: 10,
            optionalInt32: 0,
        })
        const expected = `
            09 000000000000f03f
            15 0000803f
            18 01
            20 01
            28 01
            31 0100000000000000
            3d 01000000
            40 01
            4a 0131
            52 01 01
            58 01
            60 01
            8a01 13
              6d 01000000
              71 0100000000000000
              78 02
              8001 02
            9201 08 000000000000f03f
            9a01 13
              6d 02000000
              71 0200000000000000
              78 04
              8001 04
            a201 0a
              0a 03 6f6e65 12 03 756e6f
            aa01 1c
              0a 05 696e6e6572 12 13
                6d 03000000
                71 0300000000000000
                78 06
                8001 06
            b201 04
               08 01 10 02
            ba01 07
               08 01 12 03 796570
            c201 09
              09 000000000000f03f
            f901 efbeadde00000000
            aa02 02 080a
            e002 00
            d201 06 737472696e67
            `;
        expect(hexOf(encoded)).toEqual(expected.replace(/\s/g, ''));
    })

})

describe("Reference decoding", () => {
    test('decode inner works', () => { 
        const decoded = Inner.decode(fromHex("8001eaf0e0fd5b"));
        expect(decoded.zigzagLong).toBe("12345678901");
    })

    test('decode empty inner works', () => {
        const decoded = Inner.decode(fromHex(""));
        expect(decoded.zigzagLong).toBe("0");
    })

    test('decode outer with enum works', () => {
        const decoded = Outer.decode(fromHex("6002"));
        expect(decoded.enumVal).toBe(EnumType.Two);
        expect(decoded.enumVal.toNumber()).toBe(2);
    })

    test('decode outer with inner works', () => {
        const decoded = Outer.decode(fromHex("8a01078001eaf0e0fd5b"));
        expect(decoded.inner?.zigzagLong).toBe("12345678901")
    })

    test('decode outer within outer works', () => {
        const decoded = Outer.decode(fromHex("09000000000000f03fc20109090000000000000040"));
        expect(decoded.doubleVal).toBe(1);
        expect(decoded.recursive?.doubleVal).toBe(2);
    })

    test('decode outer with inner in oneof works', () => {
        const decoded = Outer.decode(fromHex(`ca01078001eaf0e0fd5b`));
        if ((decoded as any).union.type !== "innerOption")
            fail("unionCase not set correctly for decoded");
        expect((decoded as any).union.innerOption?.zigzagLong).toBe("12345678901");
    })

    test('decode outer with imported oneof works', () => {
        const decoded = Outer.decode(fromHex(`f201070a0576616c7565`));
        if ((decoded as any).union.type !== "importedOption")
            fail("unionCase not set correctly for decoded");
        expect((decoded as any).union.importedOption).toBe("(value)");
    })

    test('decode repeated scalar', () => {
        const decoded = Outer.decode(fromHex("920118000000000000f03f00000000000000000000000000000840"));
        expect(decoded.doubles).toStrictEqual([1, 0, 3]);
    })

    test('decode repeated message', () => {
        const decoded = Outer.decode(fromHex(`9a01056d010000009a01056d2a000000`));
        expect(decoded.inners.length).toBe(2);
        expect(decoded.inners[0].intFixed).toBe(1);
        expect(decoded.inners[1].intFixed).toBe(42);
    })

    test('decode recursive message', () => {
        const decoded = Outer.decode(fromHex(`c2010909000000000000f03f`));
        expect(decoded.recursive).toBeDefined();
        expect(decoded.recursive?.doubleVal).toBe(1);
    })

    test('decode indirect recursive message', () => {
        const decoded = Inner.decode(fromHex(`8a01051203800102`));
        expect(decoded.nested).toBeDefined();
        expect(decoded.nested?.inner).toBeDefined();
        expect(decoded.nested?.inner?.zigzagLong).toBe("1");
    })

    test('decode nested message from inside', () => {
        const decoded = Outer.decode(fromHex(`da01030a0101`));
        expect(decoded.nested).toBeDefined();
        expect(decoded.nested?.enums.length).toBe(1);
        expect(decoded.nested?.enums[0]).toBe(Outer.NestEnumeration.Red);
        expect(decoded.nested?.enums[0].toNumber()).toBe(1);
    })

    test('decode nested message from outside', () => {
        const decoded = Inner.decode(fromHex(`8a01030a0101`));
        expect(decoded.nested).toBeDefined();
        expect(decoded.nested?.enums.length).toBe(1);
        expect(decoded.nested?.enums[0]).not.toBe(Outer.NestEnumeration.Black);
        expect(decoded.nested?.enums[0]).toBe(Outer.NestEnumeration.Red);
        expect(decoded.nested?.enums[0].toNumber()).toBe(1);
    })

    test('decode imported message', () => {
        const decoded = Outer.decode(fromHex(`e201040a026869`));
        expect(decoded.imported).toBeDefined();
        expect(decoded.imported?.value).toBe("hi");
    })

    test('decode hexpad field', () => {
        const decoded = Outer.decode(fromHex(`f901efbeadde00000000`));
        expect(decoded.ulongFixedHex).toBe("00000000deadbeef");
    })

    test('decode surrogate field uses surrogate type', () => {
        const decoded = Outer.decode(fromHex(`8202070a0576616c6964`));
        expect(decoded.surrogate).toEqual("(valid)");
    })

    test('decode with default surrogate field uses surrogate default', () => {
        const decoded = Outer.decode(fromHex(``));
        expect(decoded.surrogate).toEqual("default");
    })

    test('decode undefined maybe field', () => {
        const decoded = Outer.decode(fromHex(""));
        expect(decoded.maybeInt32).toEqual(undefined);
    })

    test('decode maybe field with primitive default', () => {
        const decoded = Outer.decode(fromHex("aa0200"));
        expect(decoded.maybeInt32).toEqual(0);
    })

    test('decode maybe field with primitive value', () => {
        const decoded = Outer.decode(fromHex("aa0202080a"));
        expect(decoded.maybeInt32).toEqual(10);
    })

    test('decode optional field with primitive value', () => {
        const decoded = Outer.decode(fromHex("e0020a"));
        expect(decoded.optionalInt32).toEqual(10);
    })

    test('decode optional field with primitive default', () => {
        const decoded = Outer.decode(fromHex("e00200"));
        expect(decoded.optionalInt32).toEqual(0);
    })

    test('decode optional field with primitive absent', () => {
        const decoded = Outer.decode(fromHex(""));
        expect(decoded.optionalInt32).toEqual(undefined);
    })
})

describe("map handling", () => {
    test('map of string:string works', () => {
        const encoded = Outer.encode({map: {one: "uno", two: "dos"}});
        expect(hexOf(encoded)).toBe("a2010a0a036f6e651203756e6fa2010a0a0374776f1203646f73");

        const decoded = Outer.decode(encoded);
        expect(decoded.map).toStrictEqual({one: "uno", two: "dos"});
    })

    test('map of string:message works', () => {
        const encoded = Outer.encode({mapInner: {one: {intFixed: 1}, two: {}}});
        expect(hexOf(encoded)).toBe("aa010c0a036f6e6512056d01000000aa01070a0374776f1200");

        const decoded = Outer.decode(encoded);
        expect(decoded.mapInner).toBeDefined();
        expect(decoded.mapInner?.one).toBeDefined();
        expect(decoded.mapInner?.one?.intFixed).toBe(1);
        expect(decoded.mapInner?.two).toBeDefined();
        expect(decoded.mapInner?.two?.intFixed).toBe(0);
    })

    test('map of int64:int32 works', () => {
        const encoded = Outer.encode({mapInts: {1: 1, "12345678901": 999}});
        const encoded2 = Outer.encode({mapInts: {1: 0, 170: 1}});
        expect(hexOf(encoded)).toBe("b2010408011001b2010908b5b8f0fe2d10e707");

        const decoded = Outer.decode(encoded);
        expect(decoded.mapInts).toStrictEqual({1: 1, "12345678901": 999});

        const decoded2 = Outer.decode(encoded2);
        expect(decoded2.mapInts).toStrictEqual({1: 0, 170: 1});
    })

    test('map of int64:int32 with default value works', () => {
        const encoded = Outer.encode({mapInts: {1: 0, 170: 1}});
        expect(hexOf(encoded)).toBe("b201020801b2010508aa011001");

        const decoded = Outer.decode(encoded);
        expect(decoded.mapInts).toStrictEqual({1: 0, 170: 1});
    })

    test('map of int64:int32 with default key works', () => {
        const encoded = Outer.encode({mapInts: {0: 170, 1: 1}});
        expect(hexOf(encoded)).toBe("b2010310aa01b2010408011001");

        const decoded = Outer.decode(encoded);
        expect(decoded.mapInts).toStrictEqual({0: 170, 1: 1});
    })

    test('map of boolean:string works', () => {
        const encoded = Outer.encode({mapBool: {true: "yep", false: "nope"}});
        expect(hexOf(encoded)).toBe("ba010708011203796570ba010612046e6f7065");

        const decoded = Outer.decode(encoded);
        expect(decoded.mapBool).toStrictEqual({true: "yep", false: "nope"});
    })

    test('map of boolean:string only true case works', () => {
        const encoded = Outer.encode({mapBool: {true: "yep"}});
        expect(hexOf(encoded)).toBe("ba010708011203796570");

        const decoded = Outer.decode(encoded);
        expect(decoded.mapBool).toStrictEqual({true: "yep"});
    })

    test('map of boolean:string with default value works', () => {
        const encoded = Outer.encode({mapBool: {true: "yep", false: ""}});
        expect(hexOf(encoded)).toBe("ba010708011203796570ba0100");

        const decoded = Outer.decode(encoded);
        expect(decoded.mapBool).toStrictEqual({true: "yep", false: ""});
    })
})

describe("oneof encoding", () => {
    test('no options writes nothing', () => {
        const encoded = Outer.encode({});
        expect(hexOf(encoded)).toBe("");
    })
    test('one option writes that option', () => {
        const encoded = Outer.encode({union: {stringOption: "string value"}});
        expect(hexOf(encoded)).toBe("d2010c737472696e672076616c7565");
    })
    test('other option writes that option', () => {
        const encoded = Outer.encode({union: {innerOption: {}}});
        expect(hexOf(encoded)).toBe("ca0100");
    })
    test('imported option types work', () => {
        const encoded = Outer.encode({union: {importedOption: "(value)"}});
        expect(hexOf(encoded)).toBe("f201070a0576616c7565");
    })
    // Note: this is allowed to match either one of them
    //       you should not expect the order to be predictable
    //       this test is here to make sure that exactly one of them gets encoded and gets encoded correctly
    //       it should be considered a failure if we encode both or neither or either incorrectly
    test("both options writes only one", () => {
        const encoded = Outer.encode({union: {innerOption: {}, stringOption: "string value"}});
        expect(hexOf(encoded)).toMatch(/ca0100|d2010c737472696e672076616c7565/);
    })
})

function useMethodInfo<TRequest, TResponse, TResult = TResponse>(method: Services.GrpcUnaryMethod<TRequest, TResponse> | Services.GrpcServerStreamingMethod<TRequest, TResponse, TResult>, args: TRequest) {
    return {
        ...method,
        encodedRequest: method.encode(args),
        serviceName: method.service.name,
    }
}

describe("method descriptor", () => {
    test("is useful", () => {
        const result = useMethodInfo(ServiceOne.ExampleUnaryRpc, {intFixed: 700});
        expect(hexOf(result.encodedRequest)).toEqual("6dbc020000");
        expect(result.serviceName).toEqual("ex.ample.ServiceOne");
        expect(result.name).toBe("ExampleUnaryRpc");
    })
})