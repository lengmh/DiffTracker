const runExtensionHostScenario = require('./extension.test.cjs');

exports.run = async () => {
    let timeout;
    try {
        await Promise.race([
            runExtensionHostScenario(),
            new Promise((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error('Code Diff Tracker Extension Host scenario timed out')),
                    90_000
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
