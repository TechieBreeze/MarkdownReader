/**
 * The remote read must NEVER touch the user's clone.
 *
 * The bug (2026-11-20): a repository link whose file is not in the working
 * tree is read from the repository. The Host did that with
 *
 *     git fetch --depth 1 origin <ref>      <- INTO THE USER'S CLONE
 *
 * which (a) writes `.git/shallow` and turns the user's repository into a
 * SHALLOW one (its history is truncated for every git command afterwards) and
 * (b) costs a network round trip on EVERY read - the popup then spins for
 * seconds (minutes on a slow link) with no end.
 *
 * Four workspace repositories of the user were already shallow when this was
 * found (ckdocs, customer, employee, user).
 *
 * What is checked here:
 *  1. the local object store is read directly - no fetch, no mutation;
 *  2. a ref the clone does NOT have never produces a fetch either (the
 *     scratch repository of the project is used instead);
 *  3. the clone stays intact: no `.git/shallow`, no `FETCH_HEAD`, same objects;
 *  4. the pinned commit of a link is read as a COMMIT (a known branch wins
 *     over a hash-shaped segment);
 *  5. the popup can never spin forever (a deadline) and a commit-pinned link
 *     falls back to the pinned content.
 *
 * Usage: node work/harnesses/remote-read-check.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readRemoteFile, splitRefAndFile } from '../../plugin/lib/remote.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(ROOT, 'plugin', 'src-client')

let failures = 0
const check = (name, condition, detail) => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` -> ${detail}`}`)
  }
}

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true })

/* ------------------------------------------------- a real clone as a fixture */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-remote-read-'))
const origin = path.join(tmp, 'origin.git')
const clone = path.join(tmp, 'clone')
execFileSync('git', ['init', '--bare', '--quiet', origin], { windowsHide: true })
execFileSync('git', ['init', '--quiet', clone], { windowsHide: true })
git(clone, ['config', 'user.email', 'mdr@example.com'])
git(clone, ['config', 'user.name', 'mdr'])
fs.mkdirSync(path.join(clone, 'src'), { recursive: true })
fs.writeFileSync(path.join(clone, 'src', 'Demo.java'), 'class Demo {}\n', 'utf8')
git(clone, ['add', '-A'])
git(clone, ['commit', '-m', 'first', '--quiet'])
git(clone, ['branch', '-M', 'main'])
git(clone, ['remote', 'add', 'origin', `https://user:pass@example.invalid/group/demo.git`])
const headSha = git(clone, ['rev-parse', 'HEAD']).trim()
const objectsBefore = git(clone, ['count-objects', '-v']).trim()

console.log('\n[1] the local object store is read directly - no fetch, no mutation')
const content = await readRemoteFile(clone, headSha, 'src/Demo.java')
check('the file of a pinned commit is read', content != null && content.includes('class Demo'), JSON.stringify(content))
check('the clone has no .git/shallow', !fs.existsSync(path.join(clone, '.git', 'shallow')))
check('the clone has no FETCH_HEAD (nothing was fetched)', !fs.existsSync(path.join(clone, '.git', 'FETCH_HEAD')))
check(
  'the object store did not change',
  git(clone, ['count-objects', '-v']).trim() === objectsBefore,
  git(clone, ['count-objects', '-v']).trim(),
)
check('the clone is not shallow', git(clone, ['rev-parse', '--is-shallow-repository']).trim() === 'false')

console.log('\n[2] a ref the clone does NOT have: still no fetch into the clone')
const missing = await readRemoteFile(clone, 'no-such-branch', 'src/Demo.java')
check('the missing ref yields nothing', missing == null, JSON.stringify(missing))
check('the clone still has no .git/shallow', !fs.existsSync(path.join(clone, '.git', 'shallow')))
check('the clone still has no FETCH_HEAD', !fs.existsSync(path.join(clone, '.git', 'FETCH_HEAD')))
check(
  'the object store still did not change',
  git(clone, ['count-objects', '-v']).trim() === objectsBefore,
  git(clone, ['count-objects', '-v']).trim(),
)

console.log('\n[3] the ref of a link')
const known = new Set(['main', 'feature/x'])
check('a known branch wins over a hash-shaped segment', (() => {
  const split = splitRefAndFile('a1b2c3d/src/A.java', known)
  return split && split.ref === 'a1b2c3d'
})(), 'a branch named like a short sha is not a commit')
check('a pinned commit is the ref', (() => {
  const split = splitRefAndFile('53a4bf0ddac6329218598e2b52407c90a77e3991/src/A.java', known)
  return split && split.ref === '53a4bf0ddac6329218598e2b52407c90a77e3991' && split.file === 'src/A.java'
})())
check('a branch with slashes wins over its prefix', (() => {
  const split = splitRefAndFile('feature/x/src/A.java', known)
  return split && split.ref === 'feature/x'
})())
check('an unknown ref is refused', splitRefAndFile('nope/src/A.java', known) === null)

console.log('\n[4] the Host never fetches into a repository of the workspace')
const remoteSource = fs.readFileSync(path.join(ROOT, 'plugin', 'lib', 'remote.js'), 'utf8')
// The ONLY helper that fetches takes the scratch repository of the project,
// and every call site passes that cache directory - never a clone of the
// workspace.
check('the fetch helper is only called with the cache directory', /readFileAtRef\(cacheDir, ref, file\)/.test(remoteSource))
check('the fetch helper is never called with a clone', !/readFileAtRef\(local\.dir/.test(remoteSource))
check('the existence check prints the sha (cat-file -e prints nothing)', /rev-parse', '--verify', '--quiet', `\$\{ref\}\^\{commit\}`/.test(remoteSource))
check('the local clone is read before the network', /const content = await showAtRef\(local\.dir, ref, file\)/.test(remoteSource))
check('the clone is only ever READ', !/fetch[^\n]*local\.dir/.test(remoteSource))
check('the cache repository is the only place a fetch happens', /fetchIntoCache\(dir, ref\)/.test(remoteSource))

console.log('\n[5] the popup always reaches an end')
const modalSource = fs.readFileSync(path.join(SRC, '24-modal.js'), 'utf8')
check('the remote read has a deadline', /REMOTE_READ_TIMEOUT_MS/.test(modalSource))
check('the deadline is used for the remote file', /fetchJsonWithTimeout\('\/api\/git\/remote-file'/.test(modalSource))
check('the loading state says what is happening', /正在从线上仓库取这个文件/.test(modalSource))
check('a commit-pinned link falls back to the pinned content', /requestCommit \|\| requestRefCommit/.test(modalSource))
check('the pinned commit is part of the request key', /requestRefCommit\}\\u0000\$\{requestRemote\}/.test(modalSource))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failures ? `\n${failures} check(s) failed` : '\nall remote read checks passed')
if (failures) process.exitCode = 1
