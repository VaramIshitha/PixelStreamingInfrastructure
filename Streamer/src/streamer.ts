import {
    ITransport,
    WebSocketTransport,
    SignallingProtocol,
    Messages,
    MessageHelpers,
    BaseMessage
} from '@epicgames-ps/lib-pixelstreamingcommon-ue5.5';
import { DataProtocol } from './protocol';

export interface PlayerPeer {
    id: string;
    peer_connection: RTCPeerConnection;
    data_channel: RTCDataChannel;
};

const protocol_version = "1.0.0";

export class Streamer {
    id: string;
    protocol: SignallingProtocol;
    transport: ITransport;
    player_map: Map<string, PlayerPeer>;
    local_stream: MediaStream;
    peer_connection_options: Messages.peerConnectionOptions;

    constructor(streamerId: string) {
        this.id = streamerId;
        this.player_map = new Map<string, PlayerPeer>();
        this.transport = new WebSocketTransport();
        this.protocol = new SignallingProtocol(this.transport);

        this.protocol.addListener(Messages.config.typeName, (msg: BaseMessage) =>
            this.handleConfigMessage(msg as Messages.config)
        );

        this.protocol.addListener(Messages.identify.typeName, (msg: BaseMessage) =>
            this.handleIdentifyMessage(msg as Messages.identify)
        );

        this.protocol.addListener(Messages.endpointIdConfirm.typeName, (msg: BaseMessage) =>
            this.handleEndpointIdConfirmMessage(msg as Messages.endpointIdConfirm)
        );

        this.protocol.addListener(Messages.playerConnected.typeName, (msg: BaseMessage) =>
            this.handlePlayerConnectedMessage(msg as Messages.playerConnected)
        );

        this.protocol.addListener(Messages.playerDisconnected.typeName, (msg: BaseMessage) =>
            this.handlePlayerDisconnectedMessage(msg as Messages.playerDisconnected)
        );

        this.protocol.addListener(Messages.answer.typeName, (msg: BaseMessage) =>
            this.handleAnswerMessage(msg as Messages.answer)
        );

        this.protocol.addListener(Messages.iceCandidate.typeName, (msg: BaseMessage) =>
            this.handleIceMessage(msg as Messages.iceCandidate)
        );
    }

    onEndpointConfirmed: () => void;
    onPlayerConnected: (player: PlayerPeer) => void;
    onPlayerDisconnected: (player_id: string) => void;

    startStreaming(signallingURL: string, stream: MediaStream) {
        this.local_stream = stream;
        this.transport.connect(signallingURL);
    }

    handleConfigMessage(msg: Messages.config) {
        this.peer_connection_options = msg.peerConnectionOptions;
    }

    handleIdentifyMessage(_msg: Messages.identify) {
        const endpointMessage = MessageHelpers.createMessage(Messages.endpointId, { id: this.id, protocolVersion: protocol_version });
        this.protocol.sendMessage(endpointMessage);
    }

    handleEndpointIdConfirmMessage(_msg: Messages.endpointIdConfirm) {
        if (this.onEndpointConfirmed) {
            this.onEndpointConfirmed();
        }
    }

    async handlePlayerConnectedMessage(msg: Messages.playerConnected) {
        if (this.local_stream) {
            const player_id = msg.playerId;
            const peer_connection = new RTCPeerConnection(this.peer_connection_options);

            peer_connection.onicecandidate = (event) => {
                if (event.candidate) {
                    this.protocol.sendMessage(MessageHelpers.createMessage(Messages.iceCandidate, { playerId: player_id, candidate: event.candidate }));
                }
            };

            this.local_stream.getTracks().forEach((track) => {
                peer_connection.addTrack(track, this.local_stream);
            });

            const data_channel = peer_connection.createDataChannel("datachannel", { ordered: true, negotiated: false });
            data_channel.binaryType = "arraybuffer";
            data_channel.onopen = () => {
                this.sendDataProtocol(player_id);
                this.sendInitialSettings(player_id);
            };
            data_channel.onclose = () => {
            };
            data_channel.onmessage = (e: MessageEvent) => {
                const message = new Uint8Array(e.data)
                this.handleDataChannelMessage(player_id, message);
            }

            this.player_map[player_id] = {
                player_id: player_id,
                peer_connection: peer_connection,
                data_channel: data_channel
            };

            const offer = await peer_connection.createOffer();
            await peer_connection.setLocalDescription(offer);
            this.protocol.sendMessage(MessageHelpers.createMessage(Messages.offer, { playerId: msg.playerId, sdp: offer.sdp }));

            if (this.onPlayerConnected) {
                this.onPlayerConnected(this.player_map[player_id]);
            }
        }

    }

    handlePlayerDisconnectedMessage(msg: Messages.playerDisconnected) {
        const player_id = msg.playerId;
        delete this.player_map[player_id];
        if (this.onPlayerDisconnected) {
            this.onPlayerDisconnected(player_id);
        }
    }

    handleAnswerMessage(msg: Messages.answer) {
        const player_id = msg.playerId;
        if (player_id && this.player_map[player_id]) {
            const player_peer = this.player_map[player_id];
            const answer = new RTCSessionDescription({ type: 'answer', sdp: msg.sdp });
            player_peer.peer_connection.setRemoteDescription(answer);
        }
    }

    handleIceMessage(msg: Messages.iceCandidate) {
        const player_id = msg.playerId;
        if (player_id && this.player_map[player_id]) {
            const player_peer = this.player_map[player_id];
            const candidate = new RTCIceCandidate(msg.candidate);
            player_peer.peer_connection.addIceCandidate(candidate);
        }
    }

    sendDataProtocol(player_id: string) {
        const player_peer = this.player_map[player_id];
        if (player_peer) {
            const streamer_proto = {
                Direction: 0,
            };
            for (const [message_name, message_def] of Object.entries(DataProtocol.ToStreamer)) {
                streamer_proto[message_name] = { id: message_def.id, structure: [] };
                for (const struct of message_def.structure) {
                    streamer_proto[message_name].structure.push(struct.type);
                }
            }
            const streamer_proto_str = JSON.stringify(streamer_proto);
            const streamer_buffer = this.constructMessage(DataProtocol.FromStreamer.Protocol, streamer_proto_str);
            player_peer.data_channel.send(streamer_buffer);

            const player_proto = {
                Direction: 1,
            };
            for (const [message_name, message_def] of Object.entries(DataProtocol.FromStreamer)) {
                streamer_proto[message_name] = { id: message_def.id, structure: [] };
                for (const struct of message_def.structure) {
                    streamer_proto[message_name].structure.push(struct.type);
                }
            }
            const player_proto_str = JSON.stringify(player_proto);
            const player_buffer = this.constructMessage(DataProtocol.FromStreamer.Protocol, player_proto_str);
            player_peer.data_channel.send(player_buffer);
        }
    }

    sendInitialSettings(player_id: string) {
        const temp_settings = {
            PixelStreaming:
                {
                AllowPixelStreamingCommands: false,
                DisableLatencyTest: false
            },
            Encoder:
                {
                TargetBitrate: -1,
                MaxBitrate: 20000000,
                MinQP: 5,
                MaxQP: 23,
                RateControl: "CBR",
                FillerData: 0,
                MultiPass: "FULL"
            },
            WebRTC:
                {
                DegradationPref: "MAINTAIN_FRAMERATE",
                FPS: 60,
                MinBitrate: 400000,
                MaxBitrate: 678000000,
                LowQP: 25,
                HighQP: 37
            },
            ConfigOptions:
                {}
        }

        const player_peer = this.player_map[player_id];
        if (player_peer) {
            const settings_str = JSON.stringify(temp_settings);
            console.log(settings_str);
            const settings_buffer = this.constructMessage(DataProtocol.FromStreamer.InitialSettings, settings_str);
            player_peer.data_channel.send(settings_buffer);
        }
    }

    constructMessage(message_def: any, ...args: any[]): ArrayBuffer {
        let data_size = 0;
        let arg_index = 0;

        if (message_def.structure.length != args.length) {
            console.log(`Incorrect number of parameters given to constructMessage. Got ${args.length}, expected ${message_def.structure.length}`);
            return null;
        }

        data_size += 1; // message type
        // fields
        message_def.structure.forEach((param: any) => {
            switch (param.type) {
                case "uint8": data_size += 1; break;
                case "uint16": data_size += 2; break;
                case "int16": data_size += 2; break;
                case "float": data_size += 4; break;
                case "double": data_size += 8; break;
                case "string": {
                    // size prepended string
                    const str_val = args[arg_index] as string;
                    data_size += 2;
                    data_size += 2 * str_val.length;
                }
                break;
                case "only_string": {
                    // string takes up the full message
                    const str_val = args[arg_index] as string;
                    data_size += 2 * str_val.length;
                }
                break;
            }
            arg_index += 1;
        });

        const data = new DataView(new ArrayBuffer(data_size));

        data_size = 0;
        arg_index = 0;

        data.setUint8(data_size, message_def.id);
        data_size += 1;
        message_def.structure.forEach((param: any) => {
            switch (param.type) {
                case "uint8":
                    data.setUint8(data_size, args[arg_index] as number);
                data_size += 1;
                break;
                case "uint16":
                    data.setUint16(data_size, args[arg_index] as number, true);
                data_size += 2;
                break;
                case "int16":
                    data.setInt16(data_size, args[arg_index] as number, true);
                data_size += 2;
                break;
                case "float":
                    data.setFloat32(data_size, args[arg_index] as number, true);
                data_size += 4;
                break;
                case "double":
                    data.setFloat64(data_size, args[arg_index] as number, true);
                data_size += 8;
                break;
                case "string": {
                    const str_val = args[arg_index] as string;
                    data.setUint16(data_size, str_val.length, true);
                    data_size += 2;
                    for (let i = 0; i < str_val.length; ++i) {
                        data.setUint16(data_size, str_val.charCodeAt(i), true);
                        data_size += 2;
                    }
                }
                break;
                case "only_string": {
                    const str_val = args[arg_index] as string;
                    for (let i = 0; i < str_val.length; ++i) {
                        data.setUint16(data_size, str_val.charCodeAt(i), true);
                        data_size += 2;
                    }
                }
                break;
            }
            arg_index += 1;
        });

        return data.buffer;
    }

    deconstructMessage(message: Uint8Array) {
        const data = new DataView(message.buffer);
        let data_offset = 0;

        // read the message type
        const message_type = data.getUint8(data_offset);
        data_offset += 1;

        // get the message definition
        const message_def = (() => {
            for (const def of Object.values(DataProtocol.ToStreamer)) {
                if (def.id == message_type) {
                    return def;
                }
            }
            return null;
        })();

        if (!message_def) {
            console.log(`Unknown message from player: ${message_type}`);
            return null;
        }

        const result_message = {};
        message_def.structure.forEach((param: any) => {
            let value: any;
            switch (param.type) {
                case "uint8":
                    value = data.getUint8(data_offset);
                data_offset += 1;
                break;
                case "uint16":
                    value = data.getUint16(data_offset);
                data_offset += 2;
                break;
                case "int16":
                    value = data.getInt16(data_offset);
                data_offset += 2;
                break;
                case "float":
                    value = data.getFloat32(data_offset);
                data_offset += 4;
                break;
                case "double":
                    value = data.getFloat64(data_offset);
                data_offset += 8;
                break;
                case "string": {
                    const str_len = data.getUint16(data_offset);
                    data_offset += 2;
                    const text_decoder = new TextDecoder('utf-16');
                    value = text_decoder.decode(data.buffer.slice(data_offset, data_offset + str_len));
                    data_offset += str_len;
                }
                break;
                case "only_string": {
                    const text_decoder = new TextDecoder('utf-16');
                    value = text_decoder.decode(data.buffer.slice(1));
                }
                break;
            }
            result_message[param.name] = value;
        });

        return { type: message_type, message: result_message };
    }

    handleDataChannelMessage(player_id: string, message: Uint8Array) {
        const result = this.deconstructMessage(message);
        console.log(`Got message: ${JSON.stringify(result)}`);
    }
}

