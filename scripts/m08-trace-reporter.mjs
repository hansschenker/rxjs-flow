/**
 * Optional Vitest host reporter for the local workerd causal checkpoint.
 * The test supplies only its bounded, redacted trace metadata after assertions.
 * No Worker endpoint, environment binding, or application logger is installed.
 *
 * npm run test:worker -- src/worker/todo-trace.integration.test.ts \
 *   --reporter=default --reporter=./scripts/m08-trace-reporter.mjs
 *
 * Redirect stdout to a log and extract the JSON after M08_TRACE_CAPTURE.
 */
export default function createM08TraceReporter() {
	return {
		onTestCaseResult(test) {
			const capture = test.meta().m08TraceCapture;
			if (capture && test.result().state === 'passed') {
				process.stdout.write(`M08_TRACE_CAPTURE ${JSON.stringify(capture)}\n`);
			}
		},
	};
}
