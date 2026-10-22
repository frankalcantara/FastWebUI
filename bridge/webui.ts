'use-strict'; // Force strict mode for transpiled

/*
  WebUI Bridge

  https://webui.me
  https://github.com/webui-dev/webui
  Copyright (c) 2020-2026 Hassan Draga.
  Licensed under MIT License.
  All rights reserved.
  Canada.

  Converted from JavaScript to TypeScript
  By Oculi Julien. Copyright (c) 2023.
*/

//@ts-ignore use *.ts import real extension
import { AsyncFunction, addRefreshableEventListener } from './utils.ts';

type DataTypes = string | number | boolean | Uint8Array;

class WebuiBridge {
	// WebUI Settings
	#secure: boolean;
	#token: number;
	#port: number;
	#log: boolean;
	#winX: number;
	#winY: number;
	#winW: number;
	#winH: number;
	#customWindowDrag: boolean;
	// Frameless Dragging
	#enableCustomDragging: boolean = false;
	#isDragging: boolean = false;
	#dragArmed: boolean = false;
	#currentWindowX: number = window.screenX || window.screenLeft;
	#currentWindowY: number = window.screenY || window.screenTop;
	// Internals
	#ws: WebSocket;
	#wsStayAlive: boolean = true;
	#wsStayAliveTimeout: number = 500;
	#wsWasConnected: boolean = false;
	#TokenAccepted: boolean = false;
	#closeReason: number = 0;
	#closeValue: string;
	#AllEvents: boolean = false;
	#callPromiseID: Uint16Array = new Uint16Array(1);
	#callPromiseResolve: (((data: string) => unknown) | undefined)[] = [];
	#allowNavigation: boolean = true;
	#bindsList: Set<string> = new Set();
	#bindsListTimeout: number = 10000;
	#tokenWaiters: { resolve: (ok: boolean) => void; timer: number }[] = [];
	// Shared codecs (kept as members, the bundle is a classic script and top-level names would be globals)
	#encoder: TextEncoder = new TextEncoder();
	#decoder: TextDecoder = new TextDecoder();
	#pingPacket: Uint8Array = new TextEncoder().encode('ping');
	// WebUI Const
	#WEBUI_SIGNATURE: number = 221;
	#CMD_JS: number = 254;
	#CMD_JS_QUICK: number = 253;
	#CMD_CLICK: number = 252;
	#CMD_NAVIGATION: number = 251;
	#CMD_CLOSE: number = 250;
	#CMD_CALL_FUNC: number = 249;
	#CMD_SEND_RAW: number = 248;
	#CMD_NEW_ID: number = 247;
	#CMD_MULTI: number = 246;
	#CMD_CHECK_TK: number = 245;
	#CMD_WINDOW_DRAG: number = 244;
	#CMD_WINDOW_RESIZED: number = 243;
	#MULTI_CHUNK_SIZE: number = 65500;
	#PROTOCOL_SIZE: number = 8; // Protocol header size in bytes
	#PROTOCOL_SIGN: number = 0; // Protocol byte position: Signature (1 Byte)
	#PROTOCOL_TOKEN: number = 1; // Protocol byte position: Token (4 Bytes)
	#PROTOCOL_ID: number = 5; // Protocol byte position: ID (2 Bytes)
	#PROTOCOL_CMD: number = 7; // Protocol byte position: Command (1 Byte)
	#PROTOCOL_DATA: number = 8; // Protocol byte position: Data (n Byte)
	#Token: Uint32Array = new Uint32Array(1);
	#Ping: Boolean = true;
	// Events
	#eventsCallback: ((event: number) => void) | null = null;
	#lastEvent: number = -1;
	event = {
		// TODO: Make `event` static and solve the ESBUILD `_WebuiBridge` issue.
        CONNECTED: 0,
        DISCONNECTED: 1,
    };
	// Constructor
	constructor({
		secure = false,
		token = 0,
		port = 0,
		log = false,
		winX = 0,
		winY = 0,
		winW = 0,
		winH = 0,
		customWindowDrag = false
	}: {
		secure: boolean;
		token: number;
		port: number;
		log?: boolean;
		winX: number;
		winY: number;
		winW: number;
		winH: number;
		customWindowDrag: boolean;
	}) {
		// Constructor arguments are injected by webui.c
		this.#secure = secure;
		this.#token = token;
		this.#port = port;
		this.#log = log;
		this.#winX = winX;
		this.#winY = winY;
		this.#winW = winW;
		this.#winH = winH;
		this.#enableCustomDragging = customWindowDrag;
		// Token
		this.#Token[0] = this.#token;
		// Instance
		if ('webui' in globalThis) {
			throw new Error('Sorry. WebUI is already defined, only one instance is allowed.');
		}
		// Positioning the current window
		if (this.#winX !== undefined && this.#winY !== undefined) {
			// window.moveTo(this.#winX, this.#winY);
		}
		// Resize the current window
		if (this.#winW !== undefined && this.#winH !== undefined) {
			// window.resizeTo(this.#winW, this.#winH);
		}
		// WebSocket
		if (!('WebSocket' in window)) {
			this.#showWarning('WebSocket is not supported by your web browser');
			if (!this.#log) globalThis.close();
		}
		// Connect to the backend application
		this.#start();
		// Navigation event listener
		if ('navigation' in globalThis) {
			globalThis.navigation.addEventListener('navigate', (event) => {
				if (!this.#allowNavigation) {
					if (this.#AllEvents && (this.#wsIsConnected())) {
						event.preventDefault();
						const url = new URL(event.destination.url);
						if (this.#log) console.log(`WebUI -> DOM -> Navigation Event [${url.href}]`);
						this.#sendEventNavigation(url.href);
					}
				}
			});
		} else {
			// Click navigation event listener
			addRefreshableEventListener(document.body, 'a', 'click', (event) => {
				if (!this.#allowNavigation) {
					if (this.#AllEvents && (this.#wsIsConnected())) {
						event.preventDefault();
						const { href } = event.target as HTMLAnchorElement;
						if (this.#log) console.log(`WebUI -> DOM -> Navigation Click Event [${href}]`);
						this.#sendEventNavigation(href);
					}
				}
			});
		}
		// Prevent F5 refresh
		document.addEventListener('keydown', (event) => {
			if (this.#log) return; // Allowed in debug mode
			if (event.key === 'F5') event.preventDefault();
		});
		// Frameless Dragging
		if (this.#enableCustomDragging) {
			// WebUI drag app-region custom implementation for Linux (X11/Wayland)
			const resolveRegion = (el: Element | null): string => {
				while (el) {
					const region = window.getComputedStyle(el).getPropertyValue("--webui-app-region").trim();
					if (region === "drag" || region === "no-drag") return region;
					el = el.parentElement;
				}
				return "";
			};
			document.addEventListener("mousedown", (e) => {
				this.#isDragging = false;
				this.#dragArmed = (e.button === 0) && (resolveRegion(e.target as Element | null) === "drag");
			}, { passive: true });
			document.addEventListener("mousemove", (e) => {
				if (e.buttons !== 1) {
					this.#dragArmed = false;
					this.#isDragging = false;
					return;
				}
				if (this.#dragArmed && !this.#isDragging) {
					this.#isDragging = true;
					this.#sendDrag();
				}
			}, { passive: true });
			document.addEventListener("mouseup", () => {
				this.#dragArmed = false;
				this.#isDragging = false;
			});
		}
		onbeforeunload = () => {
			this.#close();
		};
		setTimeout(() => {
			if (!this.#wsWasConnected) {
				this.#showWarning('Failed to connect to the backend application');
			}
		}, 5000);
	}
	// Methods
	#close(reason = 0, value = '') {
		this.#closeReason = reason;
		this.#closeValue = value;
		if (this.#wsIsConnected()) {
			this.#ws.close();
		}
	}
	#showWarning(msg: string) {
		setTimeout(() => {
			if (!this.#wsIsConnected()) {
				if (document.getElementById('webui-error-connection-lost')) return;
				const div = document.createElement('div');
				div.id = 'webui-error-connection-lost';
				Object.assign(div.style, {
					position: 'fixed',
					top: '0',
					left: '0',
					width: '100%',
					backgroundColor: 'rgb(191 125 30 / 84%)',
					color: '#fff',
					textAlign: 'center',
					padding: '4px 0',
					fontFamily: 'Arial, sans-serif',
					fontSize: '16px',
					zIndex: '9000',
					lineHeight: '1'
				});
				div.innerHTML = '<strong>Error:</strong> ' + msg + ' - <em>WebUI 2.5.0-beta.4</em>';
				document.body.insertBefore(div, document.body.firstChild);
			}
		}, 1000);
	}
	#freezeUi() {
		if (this.#eventsCallback == null) {
			// Show default WebUI warning as we
			// don't have a user event callback.
			this.#showWarning('Connection with the backend is lost');
		}
	}
	#unfreezeUI() {
		const div = document.getElementById('webui-error-connection-lost');
		if (div) {
			div.remove();
		}
	}
	#isTextBasedCommand(cmd: number): Boolean {
		if (cmd !== this.#CMD_SEND_RAW) return true;
		return false;
	}
	#parseDimensions(input: string): {x: number; y: number; width: number; height: number} {
		try {
			const parts = input.split(',');
			if (parts.length !== 4) return {x: 0, y: 0, width: 0, height: 0};
			const x = parseFloat(parts[0]),
				y = parseFloat(parts[1]),
				width = parseFloat(parts[2]),
				height = parseFloat(parts[3]);
			return [x, y, width, height].some(isNaN) ? {x: 0, y: 0, width: 0, height: 0} : {x, y, width, height};
		} catch {
			return {x: 0, y: 0, width: 0, height: 0};
		}
	}
	#getDataStrEnd(buffer: Uint8Array, startIndex: number): number {
		// Index of the null terminator, or the buffer end
		const end = buffer.indexOf(0, startIndex);
		return end === -1 ? buffer.length : end;
	}
	#getDataStrFromPacket(buffer: Uint8Array, startIndex: number): string {
		return this.#decoder.decode(buffer.subarray(startIndex, this.#getDataStrEnd(buffer, startIndex)));
	}
	// Allocate a packet with its header filled, `dataLen` bytes of zeroed data follow
	#newPacket(cmd: number, id: number, dataLen: number): Uint8Array {
		// Protocol
		// 0: [SIGNATURE]
		// 1: [TOKEN] Little-endian
		// 2: [ID] Little-endian
		// 3: [CMD]
		// 4: [Data]
		const packet = new Uint8Array(this.#PROTOCOL_SIZE + dataLen);
		const token = this.#token;
		packet[this.#PROTOCOL_SIGN] = this.#WEBUI_SIGNATURE;
		packet[this.#PROTOCOL_TOKEN] = token & 0xff;
		packet[this.#PROTOCOL_TOKEN + 1] = (token >>> 8) & 0xff;
		packet[this.#PROTOCOL_TOKEN + 2] = (token >>> 16) & 0xff;
		packet[this.#PROTOCOL_TOKEN + 3] = (token >>> 24) & 0xff;
		packet[this.#PROTOCOL_ID] = id & 0xff;
		packet[this.#PROTOCOL_ID + 1] = (id >>> 8) & 0xff;
		packet[this.#PROTOCOL_CMD] = cmd;
		return packet;
	}
	#getID(buffer: Uint8Array, index: number): number {
		if (index < 0 || index >= buffer.length - 1) {
			throw new Error('Index out of bounds or insufficient data.');
		}
		const firstByte = buffer[index];
		const secondByte = buffer[index + 1];
		const combined = (secondByte << 8) | firstByte; // Works only for little-endian
		return combined;
	}
	#start() {
		this.#keepAlive();
		this.#callPromiseID[0] = 0;
		// Connect to the backend application
		this.#wsConnect();
	}
	#keepAlive = async () => {
		while (true) {
			if (this.#Ping) {
				// Some web browsers may close the connection
				// let's send a void message to keep WS open
				this.#sendData(this.#pingPacket);
			} else {
				// There is an active communication
				this.#Ping = true;
			}
			await new Promise((resolve) => setTimeout(resolve, 20000));
		}
	};
	#clicksListener() {
		const elements = document.querySelectorAll<HTMLElement>("[id]");
		for (let i = 0; i < elements.length; i++) {
			const e = elements[i];
			const id = e.id;
			if (id === '') continue;
			if (this.#AllEvents || this.#bindsList.has(id)) {
				if (!e.hasAttribute('data-webui_click_is_set')) {
					e.setAttribute('data-webui_click_is_set', 'true');
					e.addEventListener("click", () => this.#sendClick(id));
				}
			}
		}
	}
	#sendData(packet: Uint8Array) {
		this.#Ping = false;
		if ((!this.#wsIsConnected()) || packet === undefined) return;
		// `WebSocket.send()` is synchronous, so a multi packet can't be interleaved
		if (packet.length < this.#MULTI_CHUNK_SIZE) {
			this.#ws.send(packet);
			return;
		}
		// Pre-packet to let WebUI be ready for multi packet
		const size = this.#encoder.encode(packet.length.toString());
		const pre_packet = this.#newPacket(this.#CMD_MULTI, 0, size.length + 1);
		pre_packet[this.#PROTOCOL_TOKEN] = 0;
		pre_packet[this.#PROTOCOL_TOKEN + 1] = 0;
		pre_packet[this.#PROTOCOL_TOKEN + 2] = 0;
		pre_packet[this.#PROTOCOL_TOKEN + 3] = 0;
		pre_packet.set(size, this.#PROTOCOL_DATA);
		this.#ws.send(pre_packet);
		// Send chunks
		for (let offset = 0; offset < packet.length; offset += this.#MULTI_CHUNK_SIZE) {
			this.#ws.send(packet.subarray(offset, Math.min(offset + this.#MULTI_CHUNK_SIZE, packet.length)));
		}
	}
	#sendClick(elem: string) {
		if (this.#wsIsConnected()) {
			// Protocol
			// 0: [SIGNATURE]
			// 1: [TOKEN]
			// 2: [ID]
			// 3: [CMD]
			// 4: [Element, Null]
			const name = this.#encoder.encode(elem);
			const packet = this.#newPacket(this.#CMD_CLICK, 0, name.length + 1);
			packet.set(name, this.#PROTOCOL_DATA);
			this.#sendData(packet);
			if (this.#log) console.log(`WebUI -> Send Click [${elem}]`);
		}
	}
	#checkToken() {
		if (this.#wsIsConnected()) {
			// Protocol
			// 0: [SIGNATURE]
			// 1: [TOKEN]
			// 2: [ID]
			// 3: [CMD]
			// 4: [Null]
			this.#sendData(this.#newPacket(this.#CMD_CHECK_TK, 0, 1));
			if (this.#log) console.log(`WebUI -> Send Token [0x${this.#token.toString(16).padStart(8, '0')}]`);
		}
	}
	#sendEventNavigation(url: string) {
		if (url !== '') {
			if (this.#wsIsConnected()) {
				if (this.#log) console.log(`WebUI -> Send Navigation Event [${url}]`);
				// Protocol
				// 0: [SIGNATURE]
				// 1: [TOKEN]
				// 2: [ID]
				// 3: [CMD]
				// 4: [URL]
				const bytes = this.#encoder.encode(url);
				const packet = this.#newPacket(this.#CMD_NAVIGATION, 0, bytes.length);
				packet.set(bytes, this.#PROTOCOL_DATA);
				this.#sendData(packet);
			}
		}
	}
	#sendDrag() {
		if (this.#wsIsConnected()) {
			if (this.#log) console.log(`WebUI -> Send window drag event`);
			// Sent once, the backend GTK starts a native window-manager move.
			this.#sendData(this.#newPacket(this.#CMD_WINDOW_DRAG, 0, 0));
		}
	}
	#closeWindowTimer() {
		setTimeout(function () {
			globalThis.close();
		}, 1000);
	}
	#updateBindsList() {
		if (this.#bindsList.has('')) {
			this.#AllEvents = true;
			this.#allowNavigation = false;
		}
		this.#generateCallObjects();
		this.#clicksListener();
	}
	#addBind(bind: string) {
		// Only the new bind needs a call object, the older ones already have theirs
		this.#bindsList.add(bind);
		if (bind === '') {
			this.#AllEvents = true;
			this.#allowNavigation = false;
		}
		this.#defineCallObject(bind);
		this.#clicksListener();
	}
	#toUint16(value: number): number {
		return value & 0xffff;
	}
	#defineCallObject(fn: string) {
		if (fn.trim() && fn !== '__webui_core_api__') {
			if (typeof (window as any)[fn] === 'undefined') {
				this[fn] = (...args: DataTypes[]) => this.call(fn, ...args);
				(window as any)[fn] = (...args: string[]) => this.call(fn, ...args);
				if (this.#log) console.log(`WebUI -> Binding backend function [${fn}]`);
			}
		}
	}
	#generateCallObjects() {
		for (const bind of this.#bindsList) {
			this.#defineCallObject(bind);
		}
	}
	#getScriptUrl() {
		const scripts = Array.from(document.scripts)
			.filter(s => s.src !== null && s.src.startsWith('http') && s.src.endsWith('webui.js'))
			.map(s => s.src);
		return scripts.length === 0 ? null : new URL(scripts[0]);
	}
	#callPromise(fn: string, ...args: DataTypes[]) {
		--this.#callPromiseID[0];
		const callId = this.#toUint16(this.#callPromiseID[0]);
		// Encode every argument once
		const fnBytes = this.#encoder.encode(fn);
		const values: Uint8Array[] = new Array(args.length);
		const lengths: number[] = new Array(args.length);
		let valuesSize = 0;
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			// Uint8Array, or string/number/boolean
			const buffer = (typeof arg === 'object') ? arg : this.#encoder.encode(arg.toString());
			values[i] = buffer;
			lengths[i] = buffer.length;
			valuesSize += buffer.length + 1;
		}
		const lengthsBytes = this.#encoder.encode(lengths.join(';'));
		// Protocol
		// 0: [SIGNATURE]
		// 1: [TOKEN]
		// 2: [ID]
		// 3: [CMD]
		// 4: [Fn, Null, {LenLen...}, Null, {Data,Null,Data,Null...}]
		const packet = this.#newPacket(
			this.#CMD_CALL_FUNC,
			callId,
			fnBytes.length + 1 + lengthsBytes.length + 1 + valuesSize,
		);
		let pos = this.#PROTOCOL_DATA;
		packet.set(fnBytes, pos);
		pos += fnBytes.length + 1; // Null
		packet.set(lengthsBytes, pos);
		pos += lengthsBytes.length + 1; // Null
		for (const buffer of values) {
			packet.set(buffer, pos);
			pos += buffer.length + 1; // Null
		}
		return new Promise((resolve) => {
			this.#callPromiseResolve[callId] = resolve;
			this.#sendData(packet);
		});
	}
	async callCore(fn: string, ...args: DataTypes[]): Promise<DataTypes> {
		return this.call('__webui_core_api__', fn, ...args);
	}
	// -- WebSocket ----------------------------
	#wsIsConnected(): boolean {
		return ((this.#ws) && (this.#ws.readyState === WebSocket.OPEN));
	}
	#wsWaitForBindsList(): Promise<boolean> {
		// The backend can run a script in this page before the token
		// handshake is done, and the bind list comes with that handshake.
		// Waiters are released by the handshake or by the connection loss.
		if (!this.#wsIsConnected()) return Promise.resolve(false);
		if (this.#TokenAccepted) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timer = setTimeout(() => this.#wsReleaseWaiters(), this.#bindsListTimeout) as unknown as number;
			this.#tokenWaiters.push({ resolve, timer });
		});
	}
	#wsReleaseWaiters(): void {
		const waiters = this.#tokenWaiters;
		if (waiters.length === 0) return;
		this.#tokenWaiters = [];
		const ready = this.#TokenAccepted && this.#wsIsConnected();
		for (const waiter of waiters) {
			clearTimeout(waiter.timer);
			waiter.resolve(ready);
		}
	}
	#wsConnect(): void {
		if (this.#wsIsConnected()) {
			this.#ws.close();
		}
		this.#TokenAccepted = false;
		const scriptUrl = this.#getScriptUrl();
		const host = scriptUrl !== null ? scriptUrl.hostname : window.location.hostname;
		const url = this.#secure ? ('wss://' + host) : ('ws://' + host);
		this.#ws = new WebSocket(`${url}:${this.#port}/_webui_ws_connect`);
		this.#ws.binaryType = 'arraybuffer';
		this.#ws.onopen = this.#wsOnOpen.bind(this);
		this.#ws.onmessage = this.#wsOnMessage.bind(this);
		this.#ws.onclose = this.#wsOnClose.bind(this);
		this.#ws.onerror = this.#wsOnError.bind(this);
	}
	#wsOnOpen = (event: Event) => {
		this.#wsWasConnected = true;
		this.#unfreezeUI();
		if (this.#log) console.log('WebUI -> Connected');
		this.#checkToken();
	};
	#wsOnError = (event: Event) => {
		if (this.#log) console.log(`WebUI -> Connection failed.`);
	};
	#wsOnClose = (event: CloseEvent) => {
		this.#wsReleaseWaiters();
		if (this.#closeReason === this.#CMD_NAVIGATION) {
			this.#closeReason = 0;
			if (this.#log) console.log(`WebUI -> Connection lost. Navigation to [${this.#closeValue}]`);
			this.#allowNavigation = true;
			globalThis.location.replace(this.#closeValue);
		} else {
			if (this.#wsStayAlive) {
				// Re-connect
				if (this.#log) console.log(`WebUI -> Connection lost (${event.code}). Reconnecting...`);
				this.#freezeUi();
				setTimeout(() => this.#wsConnect(), this.#wsStayAliveTimeout);
			}
			else if (this.#log) {
				// Debug close
				console.log(`WebUI -> Connection lost (${event.code})`);
				this.#freezeUi();
			} else {
				// Release close
				this.#closeWindowTimer();
			}
		}
		// Event Callback
		this.#userEventCallback(this.event.DISCONNECTED);
	};
	#userEventCallback = (e: number) => {
		if (this.#eventsCallback) {
			if (e != this.#lastEvent) {
				this.#lastEvent = e;
				this.#eventsCallback(e);
			}
		}
	}
	#wsOnMessage = async (event: MessageEvent) => {
		const buffer8 = new Uint8Array(event.data);
		if (buffer8.length < this.#PROTOCOL_SIZE) return;
		if (buffer8[this.#PROTOCOL_SIGN] !== this.#WEBUI_SIGNATURE) return;
		if (this.#isTextBasedCommand(buffer8[this.#PROTOCOL_CMD])) {
			// UTF8 Text based commands
			const callId = this.#getID(buffer8, this.#PROTOCOL_ID);
			// Process Command
			switch (buffer8[this.#PROTOCOL_CMD]) {
				case this.#CMD_JS_QUICK:
				case this.#CMD_JS:
					{
						// Protocol
						// 0: [SIGNATURE]
						// 1: [TOKEN]
						// 2: [ID]
						// 3: [CMD]
						// 4: [Script]
						const script: string = this.#getDataStrFromPacket(buffer8, this.#PROTOCOL_DATA);
						// Normalize line endings only when needed
						const scriptSanitize = script.includes('\r') ? script.replace(/(?:\r\n|\r|\n)/g, '\n') : script;
						if (this.#log) console.log(`WebUI -> CMD -> JS [${scriptSanitize}]`);
						// Get callback result
						let FunReturn: string | Uint8Array = 'undefined';
						let FunError = false;
						let isBinaryReturn = false;
						try {
							const result = await AsyncFunction(scriptSanitize)();
							if (result instanceof Uint8Array) {
								FunReturn = result;
								isBinaryReturn = true;
							} else {
								FunReturn = String(result);
							}
						} catch (e) {
							FunError = true;
							FunReturn = e.message;
						}
						// Stop if this is a quick call
						if (buffer8[this.#PROTOCOL_CMD] === this.#CMD_JS_QUICK) return;
						// Get the call return
						if (FunReturn === undefined) {
							FunReturn = 'undefined';
						}
						// Logging
						if (this.#log && !FunError) {
							if (isBinaryReturn) {
								const binaryData = FunReturn as Uint8Array;
								const hexPreview = Array.from(binaryData.slice(0, 64)).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ');
								console.log(`WebUI -> CMD -> JS -> Return Success (${binaryData.length} Bytes) [${hexPreview}${binaryData.length > 64 ? '...' : ''}]`);
							} else {
								const stringData = String(FunReturn);
								console.log(`WebUI -> CMD -> JS -> Return Success (${this.#encoder.encode(stringData).length} Bytes) [${stringData.substring(0, 64)}${stringData.length > 64 ? '...' : ''}]`);
							}
						}
						else if (this.#log && FunError) {
							const errorString = String(FunReturn);
							console.log(`WebUI -> CMD -> JS -> Return Error [${errorString.substring(0, 64)}${errorString.length > 64 ? '...' : ''}]`);
						}
						// Protocol
						// 0: [SIGNATURE]
						// 1: [TOKEN]
						// 2: [ID]
						// 3: [CMD]
						// 4: [Error, Script Response, Null]
						const payload: Uint8Array = isBinaryReturn
							? (FunReturn as Uint8Array)
							: this.#encoder.encode(FunReturn as string);
						const packet = this.#newPacket(this.#CMD_JS, callId, payload.length + 2);
						packet[this.#PROTOCOL_DATA] = FunError ? 1 : 0;
						packet.set(payload, this.#PROTOCOL_DATA + 1);
						this.#sendData(packet);
					}
					break;
				case this.#CMD_CALL_FUNC:
					{
						// Protocol
						// 0: [SIGNATURE]
						// 1: [TOKEN]
						// 2: [ID]
						// 3: [CMD]
						// 4: [Call Response]
						const callResponse: string = this.#getDataStrFromPacket(buffer8, this.#PROTOCOL_DATA);
						if (this.#log) {
							console.log(`WebUI -> CMD -> Call Response [${callResponse}]`);
						}
						if (this.#callPromiseResolve[callId]) {
							if (this.#log) {
								console.log(`WebUI -> CMD -> Resolving Response #${callId}...`);
							}
							this.#callPromiseResolve[callId]?.(callResponse);
							this.#callPromiseResolve[callId] = undefined;
						}
					}
					break;
				case this.#CMD_NAVIGATION:
					// Protocol
					// 0: [SIGNATURE]
					// 1: [TOKEN]
					// 2: [ID]
					// 3: [CMD]
					// 4: [URL]
					const url: string = this.#getDataStrFromPacket(buffer8, this.#PROTOCOL_DATA);
					if (this.#log) console.log(`WebUI -> CMD -> Navigation [${url}]`);
					this.#close(this.#CMD_NAVIGATION, url);
					break;
				case this.#CMD_WINDOW_RESIZED:
					// Protocol
					// 0: [SIGNATURE]
					// 1: [TOKEN]
					// 2: [ID]
					// 3: [CMD]
					// 4: [x,y,width,height]
					const widthAndHeight: string = this.#getDataStrFromPacket(buffer8, this.#PROTOCOL_DATA);
					const { x, y, width, height } = this.#parseDimensions(widthAndHeight);
					// Update drag positions
					this.#currentWindowX = x;
					this.#currentWindowY = y;
					if (this.#log) console.log(`WebUI -> CMD -> Window Resized [x: ${x}, y: ${y}, width: ${width}, height: ${height}]`);
					break;
				case this.#CMD_NEW_ID:
					// Protocol
					// 0: [SIGNATURE]
					// 1: [TOKEN]
					// 2: [ID]
					// 3: [CMD]
					// 4: [New Element]
					const newElement: string = this.#getDataStrFromPacket(buffer8, this.#PROTOCOL_DATA);
					if (this.#log) console.log(`WebUI -> CMD -> New Bind ID [${newElement}]`);
					this.#addBind(newElement);
					break;
				case this.#CMD_CLOSE:
					// Protocol
					// 0: [SIGNATURE]
					// 1: [TOKEN]
					// 2: [ID]
					// 3: [CMD]
					if (this.#log) {
						// Debug Close
						console.log(`WebUI -> CMD -> Close`);
						if (this.#wsIsConnected()) {
							this.#wsStayAlive = false;
							this.#ws.close();
						}
					}
					else {
						// Release Close
						globalThis.close();
					}
					break;
				case this.#CMD_CHECK_TK:
					// Protocol
					// 0: [SIGNATURE]
					// 1: [TOKEN]
					// 2: [ID]
					// 3: [CMD]
					// 4: [Status]
					// 5: [BindsList]
					const status = (buffer8[this.#PROTOCOL_DATA] == 0 ? false : true);
					const tokenHex = `0x${this.#token.toString(16).padStart(8, '0')}`;
					if (status) {
						if (this.#log) console.log(`WebUI -> CMD -> Token [${tokenHex}] Accepted`);
						this.#TokenAccepted = true;
						// Get binds list (CSV)
						let csv: string = this.#getDataStrFromPacket(buffer8, this.#PROTOCOL_DATA + 1);
						csv = csv.endsWith(',') ? csv.slice(0, -1) : csv;
						this.#bindsList = new Set(csv.split(','));
						// Generate objects
						this.#updateBindsList();
						// Release the calls waiting for the bind list
						this.#wsReleaseWaiters();
						// User event callback
						this.#userEventCallback(this.event.CONNECTED);
					}
					else {
						if (this.#log) console.log(`WebUI -> CMD -> Token [${tokenHex}] Not Accepted. Reload page...`);
						// Refresh the page to get a new token
						this.#allowNavigation = true;
						this.#wsStayAlive = false;
						globalThis.location.reload();
					}
					break;
			}
		} else {
			// Raw-binary based commands
			switch (buffer8[this.#PROTOCOL_CMD]) {
				case this.#CMD_SEND_RAW:
					// Protocol
					// 0: [SIGNATURE]
					// 1: [TOKEN]
					// 2: [ID]
					// 3: [CMD]
					// 4: [Function,Null,Raw Data]
					// Get function name
					const functionName: string = this.#getDataStrFromPacket(buffer8, this.#PROTOCOL_DATA);
					// Get the raw data (the name length is in bytes, not in characters)
					const rawDataIndex: number = this.#getDataStrEnd(buffer8, this.#PROTOCOL_DATA) + 1;
					const rawDataSize: number = (buffer8.length - rawDataIndex) - 1;
					const userRawData = buffer8.subarray(rawDataIndex, (rawDataIndex + rawDataSize));
					if (this.#log) console.log(`WebUI -> CMD -> Received Raw ${rawDataSize} bytes for [${functionName}()]`);
					// Call the user function, and pass the raw data
					if (typeof window[functionName] === 'function') window[functionName](userRawData);
					else await AsyncFunction(functionName + '(userRawData)')();
					break;
			}
		}
	};
	// -- Public APIs --------------------------
	/**
	 * Call a backend function
	 *
	 * @param fn - binding name
	 * @param data - data to be send to the backend function
	 * @return - Response of the backend callback string
	 * @example - const res = await webui.call("myID", 123, true, "Hi", new Uint8Array([0x42, 0x43, 0x44]))
	 */
	async call(fn: string, ...args: DataTypes[]): Promise<DataTypes> {
		if (!fn) return Promise.reject(new SyntaxError('No binding name is provided'));

		if (!this.#TokenAccepted) await this.#wsWaitForBindsList();

		if (!this.#wsIsConnected()) return Promise.reject(new Error('WebSocket is not connected'));

		// Check binding list
		if (fn !== '__webui_core_api__') {
			if (!this.#AllEvents && !this.#bindsList.has(`${fn}`))
				return Promise.reject(new ReferenceError(`No binding was found for "${fn}"`));
		}

		// Call backend and wait for response
		if (this.#log) console.log(`WebUI -> Calling [${fn}(...)]`);
		const response = (await this.#callPromise(fn, ...args)) as string;

		// WebUI lib accept `DataTypes` but return only string
		if (typeof response !== 'string') return '';

		return response;
	}
	/**
	 * Active or deactivate webui debug logging
	 *
	 * @param status - log status to set
	 */
	setLogging(status: boolean) {
		if (status) {
			console.log('WebUI -> Log Enabled.');
			this.#log = true;
		} else {
			console.log('WebUI -> Log Disabled.');
			this.#log = false;
		}
	}
	/**
	 * Encode text into base64 string
	 *
	 * @param data - text string
	 */
	encode(data: string): string {
		return btoa(data);
	}
	/**
	 * Decode base64 string into text
	 *
	 * @param data - base64 string
	 */
	decode(data: string): string {
		return atob(data);
	}
	/**
	 * Set a callback to receive events like connect/disconnect
	 *
	 * @param callback - callback function `myCallback(e)`
	 * @example - webui.setEventCallback((e) => {if(e == webui.event.CONNECTED){ ... }});
	 */
	setEventCallback(callback: (e: number) => void): void {
        this.#eventsCallback = callback;
    }
	/**
	 * Check if UI is connected to the back-end. The connection
	 * is done by including `webui.js` virtual file in the HTML.
	 *
	 * @return - Boolean `true` if connected
	 */
	isConnected(): boolean {
		return ((this.#wsIsConnected()) && (this.#TokenAccepted));
	}
	/**
	 * Get OS high contrast preference.
	 *
	 * @return - Boolean `True` if OS is using high contrast theme
	 */
	async isHighContrast(): Promise<boolean> {
		// Call a core function and wait for response
		const response = await this.callCore("high_contrast") as boolean;
		if (this.#log) console.log(`Core Response: [${response}]`);
		return response;
	}
	/**
	 * When binding all events on the backend, WebUI blocks all navigation events
	 * and sends them to the backend. This API allows you to control that behavior.
	 *
	 * @param status - Boolean `True` means WebUI will allow navigations
	 * @example - webui.allowNavigation(true); // Allow navigation
	 * window.location.replace('www.test.com'); // This will now proceed as usual
	 */
	allowNavigation(status: boolean): void {
        this.#allowNavigation = status;
    }
}
// Export
type webui = WebuiBridge;
export default webui;
export type { WebuiBridge };
// Wait for the html to be parsed
addEventListener('load', () => {
	document.body.addEventListener('contextmenu', (event) => event.preventDefault());
	addRefreshableEventListener(document.body, 'input', 'contextmenu', (event) => event.stopPropagation());
});
