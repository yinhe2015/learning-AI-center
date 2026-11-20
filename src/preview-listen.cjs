const { Server } = require('node:net');

const socket = process.env.WORKBENCH_PREVIEW_SOCKET;
const listen = Server.prototype.listen;
const address = Server.prototype.address;

if (socket) {
  Server.prototype.listen = function (...args) {
    const requested = args[0];
    if (requested === socket || requested?.path === socket) return listen.apply(this, args);
    const callback = typeof args.at(-1) === 'function' ? args.at(-1) : undefined;
    return callback ? listen.call(this, socket, callback) : listen.call(this, socket);
  };
  Server.prototype.address = function () {
    const bound = address.call(this);
    if (bound !== socket) return bound;
    return { address: '127.0.0.1', family: 'IPv4', port: Number(process.env.PORT) };
  };
}
