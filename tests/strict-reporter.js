export default class StrictReporter {
    onBegin(_config, suite) {
        this.suite = suite
    }

    onEnd(result) {
        const tests = this.suite?.allTests() || []
        if (result.status !== 'passed' || tests.length === 0 ||
            tests.some(test => test.expectedStatus !== 'passed' || test.outcome() !== 'expected')) {
            console.error('Test summary must report a nonempty suite without failures, flakes or skips.')
            return { status: 'failed' }
        }
    }
}
