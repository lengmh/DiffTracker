const path = require('node:path');
const Mocha = require('mocha');

exports.run = () => new Promise((resolve, reject) => {
    const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 90_000 });
    mocha.addFile(path.resolve(__dirname, 'extension.test.cjs'));
    mocha.run(failures => failures > 0
        ? reject(new Error(`${failures} Extension Host test(s) failed`))
        : resolve());
});
