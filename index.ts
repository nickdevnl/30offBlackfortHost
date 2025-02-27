#!/usr/bin/env node
import { Client, Server, PacketWriter, State, Connection } from "mcproto"
import { ChildProcess, exec, spawn } from "child_process"
type Status = "online" | "offline" | "starting";

const args = process.argv.slice(2);

// args[0] = port
// args[1] = server directory
// args[2] = mc server port
// args[3] = command to start server
// args[4] = -d Show debug information (optional)

if (args.length < 4) {
    console.log('Usage: wakecraft <port> <server directory> <mc server port> "<command to start server>" [-d]');
    process.exit(1);
}

let port = Number(args[0]);
let status: Status = "offline";
let lastPacket = new Date().getTime();
let serverProcess: ChildProcess;

setInterval(async () => {
    if (status !== "online") return;
    if (new Date().getTime() - lastPacket > 300000) {
        console.log("No new activity on the server for 5 minutes, stopping server.");
        lastPacket = new Date().getTime();
        status = "offline";
        serverProcess.stdin?.write("save-all\n");
        serverProcess.stdin?.write("stop\n");
        // Wait for server to stop, if it doesn't, kill it.
        await new Promise(resolve => setTimeout(resolve, 60000));
        if (status !== "offline") {
            serverProcess.kill();
            console.log("Server did not stop, killing it.")
        }
    }
}, 1000);

new Server(async client => {
    const remoteAddr = client.socket.remoteAddress!.replace("::ffff:", "");

    const handshake = await client.nextPacket();
    const protocol = handshake.readVarInt();
    const address = handshake.readString().split("\x00")[0];

    if (status == "offline") {
        if (client.state == State.Status) {
            client.on("packet", packet => {
                if (packet.id == 0x0) client.send(new PacketWriter(0x0).writeJSON({
                    version: { name: "§4• §cOffline", protocol: -1 },
                    players: { max: -1, online: -1 },
                    description: { text: "§cThis server is offline.\n§7To start it, join the server! \n To create your own server go to blackforthosting.com and create an ticket." }
                }))
                if (packet.id == 0x1) client.send(new PacketWriter(0x1).write(packet.read(8)))
            })
        } else if (client.state == State.Login) {
            client.end(new PacketWriter(0x0).writeJSON({text: 'Server is now starting! Please wait a few minutes and join again.', color:'green'}));
            serverProcess = exec(args[3], {cwd: args[1]});
            status = "starting";

            serverProcess.stdout?.on('data', (data) => {
                console.log(data);
                if (data.toLowerCase().includes('done')) {
                    console.log('Server is now online!');
                    status = "online";
                }
            });
            serverProcess.stderr?.on('data', (data) => {
                console.error(data);
            });
            serverProcess.on('close', (code) => {
                console.log(`Server process exited with code ${code}`);
                status = "offline";
            });

            // @ts-ignore
            process.stdin.pipe(serverProcess.stdin);

            await new Promise(resolve => setTimeout(resolve, 60000));
            if (status == "starting") status = "online"; // If the server is still starting after a minute, assume it's online & start proxying
        }
        return setTimeout(() => client.end(), 1000);
    } else if (status == "starting") {
        if (client.state == State.Status) {
            client.on("packet", packet => {
                if (packet.id == 0x0) client.send(new PacketWriter(0x0).writeJSON({
                    version: { name: "§6• §eStarting...", protocol: -1 },
                    players: { max: -1, online: -1 },
                    description: { text: "§eThis server is starting.\n§7Please wait a few minutes. Refresh!" }
                }))
                if (packet.id == 0x1) client.send(new PacketWriter(0x1).write(packet.read(8)))
            })
        } else if (client.state == State.Login) {
            client.end(new PacketWriter(0x0).writeJSON({text: 'This server is already starting!', color:'green'}));
        }
        return setTimeout(() => client.end(), 1000);
    } else if (status == "online") {
        client.pause();

        // Reverse proxy
        const host = "127.0.0.1";
        const port = Number(args[2]);
        let conn: Client
        try {
            conn = await Client.connect(host, port)
        } catch (error) {
            console.log(error)
            return client.end()
        }
        conn.on("error", error => console.log(error))

        conn.send(new PacketWriter(0x0).writeVarInt(protocol)
            .writeString(host).writeUInt16(port)
            .writeVarInt(client.state))

        client.on("packet", packet => conn.send(packet))
        await client.resume();

        conn.on("end", () => client.end())
        client.on("end", () => conn.end());

        client.unpipe(), conn.unpipe()

        client.socket.pipe(conn.socket, { end: true })
        conn.socket.pipe(client.socket, { end: true })

        conn.socket.on('data', (data) => {
            // Keep only the packets that are not status packets
            if (data.length !== 10 && !data.toString().includes("version")) {
                lastPacket = new Date().getTime();
            }
        });
    }
}).listen(port)

console.log("Server listening on port " + port)
