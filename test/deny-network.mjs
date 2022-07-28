/** Deny network primitives in the child that runs the real CLI. Never bind. */
import dgram from 'node:dgram'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'

function deny() {
  process.stderr.write('OFFLINE_NETWORK_DENIED\n')
  throw new Error('OFFLINE_NETWORK_DENIED')
}

globalThis.fetch = deny
net.Server.prototype.listen = deny
net.Socket.prototype.connect = deny
dgram.Socket.prototype.bind = deny
dgram.Socket.prototype.send = deny
http.request = deny
http.get = deny
https.request = deny
https.get = deny
dns.lookup = deny
dns.resolve = deny
syncBuiltinESMExports()
