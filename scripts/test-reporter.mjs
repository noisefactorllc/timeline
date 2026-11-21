import { tap } from 'node:test/reporters'

export default async function* report(source) {
    let fileSummaries = 0
    let invalid = false

    async function* checkedEvents() {
        for await (const event of source) {
            if (event.type === 'test:summary') {
                const { counts, file, success } = event.data
                if (file) fileSummaries++
                if (!success || counts.tests === 0 || counts.passed === 0 ||
                    counts.failed || counts.cancelled || counts.skipped || counts.todo) {
                    invalid = true
                }
            }
            yield event
        }
    }

    yield* tap(checkedEvents())
    // Node can count an empty file as a passing test, but it emits no summary
    // of registered tests for that file. Require a real suite summary too.
    if (fileSummaries === 0 || invalid) {
        console.error('Test summary must report a nonempty suite with every test passing.')
        process.exitCode = 1
    }
}
