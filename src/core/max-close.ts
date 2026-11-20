type RawSocket={on:(event:'error',listener:()=>void)=>unknown;close:()=>void};
/** Keep handshake error listeners alive when cancelling an SDK reconnect.
 * SDK close removes all listeners before closing CONNECTING sockets, which emits
 * an asynchronous unhandled error. Detach the raw socket first; SDK still stops
 * timers/fails pending operations, then ws can settle its original handshake.
 */
export function closeMaxClient(client:{close:()=>void;ws:{socket:RawSocket|null}}){
 const socket=client.ws.socket;client.ws.socket=null;
 try{client.close();}finally{if(socket){socket.on('error',()=>{});socket.close();}}
}
