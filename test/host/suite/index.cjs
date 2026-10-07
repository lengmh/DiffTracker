async function bounded(description, scenario, milliseconds) {
    let timeout;
    try {
        await Promise.race([
            scenario(),
            new Promise((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error(`Code Diff Tracker ${description} timed out`)),
                    milliseconds
                );
            })
        ]);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

exports.run = async () => {
    const restart = require('./s4d-restart.test.cjs');
    const phase = process.env.DIFF_TRACKER_HOST_PHASE;
    if (phase === 'restore') {
        // A dedicated second process phase must not re-run the full suite or
        // reset the prepared review before inspecting the offline edit.
        await bounded('S4-D process restart restore', restart.restore, 45_000);
        return;
    }
    if (phase !== 'prepare') { throw new Error(`Unknown Extension Host phase: ${phase}`); }
    // Renderer discovery, real menu activation, two child-editor focuses and
    // the minimum-host picker have their own budget. Do not borrow from or
    // relax the existing 150-second full-scenario gate.
    await bounded('Native Review UI checkpoint', require('./native-review.test.cjs'), 90_000);
    // Preserve the existing full-scenario and per-assertion time budgets. The
    // small process-restart fixture has its own bounded prepare/restore phases.
    await bounded('Extension Host scenario', require('./extension.test.cjs'), 150_000);
    console.log('PASS Code Diff Tracker real Extension Host scenario');
    await bounded('S4-D process restart prepare', restart.prepare, 45_000);
};
