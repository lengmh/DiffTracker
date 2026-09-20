const runExtensionHostScenario = require('./extension.test.cjs');

exports.run = async () => {
    let timeout;
    try {
        await Promise.race([
            runExtensionHostScenario(),
            new Promise((_, reject) => {
                // S3 adds real-host scope preparation, confirmation-race and
                // pending-exclusion coverage flows before the existing review,
                // watcher and recovery matrix. Keep per-assertion deadlines
                // unchanged; only give the full Windows scenario enough total
                // wall-clock budget on slower hosted runners.
                timeout = setTimeout(
                    () => reject(new Error('Code Diff Tracker Extension Host scenario timed out')),
                    150_000
                );
            })
        ]);
        console.log('PASS Code Diff Tracker real Extension Host scenario');
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
};
