/**
 * The HOST's definition resolution (ctrl+click -> jump to definition).
 *
 * Regression for the real case the user hit: the jump to `HermesTypeEnum`
 * (and to the enum constants under it) failed in
 * `.../hermes-api/.../ApiHermesServiceImpl.java` with 「未找到定义」. Causes:
 *
 *  1. the repository discovery only looked under `<root>/gits/`, so a workspace
 *     whose repositories live deeper (`<root>/jjy/modules/<module>/.git`) was
 *     invisible - the class index had no entry and every cross-module jump
 *     failed;
 *  2. `repoJavaRoots` only looked two levels down, but a module can sit four
 *     levels down (`<repo>/xls-platform/jar/<module>/src/main/java`), so the
 *     class index stayed empty for that layout;
 *  3. the resolver never looked at the parsed ENUM CONSTANTS, so clicking
 *     `HermesTypeEnum.COUPON` found nothing even when the file was found.
 *
 * The fixture is a self-contained multi-module workspace - it must not depend
 * on the files of the machine it runs on.
 *
 * Note: every token name used for a lookup is defined ONCE and interpolated
 * into the fixture, so the file content and the lookup literal cannot drift
 * apart.
 *
 * Usage: node work/harnesses/host-def-check.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

const { createState } = await import(pathToFileURL(path.join(ROOT, 'plugin', 'lib', 'state.js')).href)
const { resolveDefinition } = await import(pathToFileURL(path.join(ROOT, 'plugin', 'lib', 'defs.js')).href)

let failures = 0
let checks = 0
function check(name, condition, detail) {
  checks += 1
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${String(JSON.stringify(detail)).slice(0, 300)}`}`)
  }
}

/* ------------------------------------------------------------- the fixture */

const TYPE_NAME = 'OtherEnum'
const CONST_NAME = 'COUPON'
const METHOD_NAME = 'getType'

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-defs-'))
const write = (rel, text) => {
  const file = path.join(ws, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}
// A repository three levels under the root: <root>/jjy/modules/<module>/.git
fs.mkdirSync(path.join(ws, 'jjy', 'modules', 'hermes-jar', '.git'), { recursive: true })
fs.mkdirSync(path.join(ws, 'jjy', 'modules', 'poseidon', '.git'), { recursive: true })

const enumRel = 'jjy/modules/poseidon/src/main/java/com/demo/OtherEnum.java'
const enumText = `package com.demo;

public enum OtherEnum {
    _DEFAULT_(0, "default"),
    ${CONST_NAME}(3500, "coupon"),
    GIFT(4000, "gift");

    private final int type;
    private final String desc;

    OtherEnum(int type, String desc) {
        this.type = type;
        this.desc = desc;
    }

    public int ${METHOD_NAME}() {
        return type;
    }
}
`
write(enumRel, enumText)

const apiRel = 'jjy/modules/hermes-jar/hermes-api/src/main/java/com/demo/Api.java'
const apiText = `package com.demo;

import com.demo.${TYPE_NAME};

public class Api {
    public int run() {
        ${TYPE_NAME}.${CONST_NAME}.${METHOD_NAME}();
        return 1;
    }
}
`
write(apiRel, apiText)

const state = createState({ packageDir: path.join(ROOT, 'plugin'), roots: [ws] })

// Columns come from the very same strings that were written to disk.
const apiLines = apiText.split('\n')
const clickLine = apiLines.findIndex((line) => line.includes(`${TYPE_NAME}.${CONST_NAME}`)) + 1
const clickText = apiLines[clickLine - 1]
const enumLines = enumText.split('\n')
const expectedConstantLine = enumLines.findIndex((line) => line.trim().startsWith(`${CONST_NAME}(`)) + 1
const expectedMethodLine = enumLines.findIndex((line) => line.includes(`int ${METHOD_NAME}()`)) + 1

/* ----------------------------------------------------------------- the tests */

console.log('\n[1] a repository below <root>/gits is found (the CK layout)')
const gitsWs = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-defs-gits-'))
const gitsClass = 'InGits'
fs.mkdirSync(path.join(gitsWs, 'gits', 'core', '.git'), { recursive: true })
fs.mkdirSync(path.join(gitsWs, 'gits', 'core', 'src', 'main', 'java', 'com', 'demo'), { recursive: true })
fs.writeFileSync(
  path.join(gitsWs, 'gits', 'core', 'src', 'main', 'java', 'com', 'demo', `${gitsClass}.java`),
  `package com.demo;\npublic class ${gitsClass} {}\n`,
  'utf8',
)
const gitsState = createState({ packageDir: path.join(ROOT, 'plugin'), roots: [gitsWs] })
const gitsResult = resolveDefinition(gitsState, {
  path: `gits/core/src/main/java/com/demo/${gitsClass}.java`,
  line: 2,
  col: 14,
  name: gitsClass,
})
check('the CK layout resolves', gitsResult && !gitsResult.error, gitsResult)

console.log('\n[2] a repository deeper in the tree is found too (the jjy layout)')
const typeCol = clickText.indexOf(TYPE_NAME) + 1
const typeResult = resolveDefinition(state, { path: apiRel, line: clickLine, col: typeCol, name: TYPE_NAME })
check('the imported type resolves', typeResult && !typeResult.error, typeResult)
check(
  'it points at the enum file of the sibling module',
  typeResult && typeResult.file && typeResult.file.includes('poseidon') && typeResult.file.endsWith(`${TYPE_NAME}.java`),
  typeResult && typeResult.file,
)

console.log('\n[3] an enum CONSTANT resolves to its declaration line')
const constantCol = clickText.indexOf(CONST_NAME) + 1
const constantResult = resolveDefinition(state, { path: apiRel, line: clickLine, col: constantCol, name: CONST_NAME })
check('the enum constant resolves', constantResult && !constantResult.error, constantResult)
check(
  'it points at the constant in the enum',
  constantResult && constantResult.file && constantResult.file.endsWith(`${TYPE_NAME}.java`) && constantResult.line === expectedConstantLine,
  { got: constantResult, expectedLine: expectedConstantLine },
)

console.log('\n[4] a method of the enum resolves')
const methodCol = clickText.indexOf(METHOD_NAME) + 1
const methodResult = resolveDefinition(state, { path: apiRel, line: clickLine, col: methodCol, name: METHOD_NAME })
check('the enum method resolves', methodResult && !methodResult.error, methodResult)
check(
  'it points at the method in the enum',
  methodResult && methodResult.file && methodResult.file.endsWith(`${TYPE_NAME}.java`) && methodResult.line === expectedMethodLine,
  { got: methodResult, expectedLine: expectedMethodLine },
)

console.log('\n[5] all kinds of the constant click agree')
for (const kind of ['constant', 'variable', 'field']) {
  const r = resolveDefinition(state, { path: apiRel, line: clickLine, col: constantCol, name: CONST_NAME, kind })
  check(`kind=${kind} resolves the constant`, r && !r.error && r.line === expectedConstantLine, r)
}

fs.rmSync(ws, { recursive: true, force: true })
fs.rmSync(gitsWs, { recursive: true, force: true })

console.log(failures ? `\n${failures} check(s) failed` : `\nall ${checks} host def checks passed`)
if (failures) process.exitCode = 1
