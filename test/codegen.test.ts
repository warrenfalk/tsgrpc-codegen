//import {Inner, Outer, EnumType, ServiceOneClient, ResultEvent} from "./reference/example.proto.gen"
import { exec, ExecException } from 'child_process';
import fs from 'fs';
import path from 'path';

async function execAsync(command: string, options?: any): Promise<{error: ExecException | null, stdout: Buffer, stderr: Buffer}> {
    return new Promise((resolve) => {
        exec(command, options, (error, stdout, stderr) => {
            const result = {error, stdout, stderr}
            resolve(result)
        })
    })
}

async function expectFileToMatchReference(relpath: string) {
    const file = path.join(__dirname, 'generated', relpath)
    const reffile = path.join(__dirname, 'reference', relpath);
    const [line1, ...lines] = (await fs.promises.readFile(file, {encoding: 'utf8'})).split('\n')
    const reflines = (await fs.promises.readFile(reffile, {encoding: 'utf8'})).split('\n');
    expect(line1).toBe('/* istanbul ignore file */');
    expect(lines).toEqual(reflines);
}

describe("generated code matches reference", () => {
    it('generates the expected files', async () => {
        const result = await execAsync("yarn run gen:test");
        expect(result.error).toBe(null);
        await expectFileToMatchReference('example.proto.gen.ts')
        await expectFileToMatchReference('importable/importMe.proto.gen.ts')
    })
})
