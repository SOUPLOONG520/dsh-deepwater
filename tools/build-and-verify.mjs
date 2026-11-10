// Build the browser entry, then run every contract check in the package.
// Usage: node tools/build-and-verify.mjs
//
// The three suites are independent on purpose:
//   verify-deepwater  - the package shape, the host half, one-switch restore
//   verify-polish     - the surface layer: token / cascade / calm / theme-safe
//   verify-ambient    - the ambience layer: DOM behaviour, light + dark frames
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function run(label, args) {
  process.stdout.write(`\n── ${label} ──\n`)
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) {
    process.stdout.write(`\n${label}: FAILED (exit ${result.status})\n`)
    process.exit(result.status ?? 1)
  }
}

run('build client.js', [join(root, 'build-client.mjs')])
run('verify-deepwater', [join(root, 'verify', 'verify-deepwater.mjs')])
run('verify-polish', [join(root, 'verify', 'verify-polish.mjs')])
run('verify-ambient', [join(root, 'verify', 'verify-ambient.mjs')])

process.stdout.write('\nAll suites passed.\n')
