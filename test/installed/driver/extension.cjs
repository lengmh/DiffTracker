// Only this extension is a development extension. It does not import, patch,
// construct, or expose product internals. The product is installed from VSIX.
exports.activate = context => ({ storageUri: context.storageUri });
