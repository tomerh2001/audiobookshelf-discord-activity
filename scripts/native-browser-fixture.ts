/** Public synthetic browser fixture. Never connects to a real media server or Discord. */
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ActivityPlaybackCoordinator } from '../apps/api/src/services/activityPlayback.js';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const HOST = process.env.FIXTURE_HOST || '172.16.0.1';
const PORT = Number(process.env.FIXTURE_PORT || 33178);
if (!['127.0.0.1', '172.16.0.1'].includes(HOST)) throw new Error('Fixture host must be loopback or the private test bridge.');
const origin = `http://${HOST}:${PORT}`;
const root = path.resolve(new URL('../native-client/dist', import.meta.url).pathname);
const sessions = new Map<string, any>(), connections = new Map<string, any>(), preferences = new Map<string, string>(), viewers = new Map<string, any>();
let party: any = null, sessionNumber = 0;
const library = { id: 'lib_fixture', name: 'Listening test library', mediaType: 'book', displayOrder: 1, provider: 'google', settings: { coverAspectRatio: 1, audiobooksOnly: true } };
const item = (id: string, title: string) => ({ id, libraryItemId: id, libraryId: library.id, mediaType: 'book', updatedAt: 1, addedAt: 1, size: 1000000,
  media: { duration: 120, numTracks: 2, numAudioFiles: 2, size: 1000000, coverPath: 'fixture-cover', tags: [], chapters: [{ id: 0, title: 'Opening', start: 0, end: 30 }, { id: 1, title: 'Second chapter', start: 30, end: 90 }, { id: 2, title: 'Final chapter', start: 90, end: 120 }], tracks: [0, 1].map(index => ({ index: index + 1, startOffset: index * 60, duration: 60, title: `Track ${index + 1}`, metadata: { filename: `fixture-${index + 1}.wav`, path: `fixture-${index + 1}.wav`, size: 1920044 }, mimeType: 'audio/wav' })), audioFiles: [0, 1].map(index => ({ index: index + 1, duration: 60, codec: 'pcm_s16le', bitRate: 256000, metadata: { filename: `fixture-${index + 1}.wav`, path: `fixture-${index + 1}.wav`, size: 1920044 } })),
    metadata: { title, subtitle: 'Generated audio test', authorName: 'Test Library', authorNameLF: 'Test Library', authors: [{ id: 'aut_fixture', name: 'Test Library' }], narratorName: 'Synthetic tone', narrators: ['Synthetic tone'], series: [], genres: ['Testing'], description: '<p>A short generated tone for verifying the native player. No real library is connected.</p>', language: 'English', publishedYear: '2026', explicit: false } } });
const items = [item('book_fixture_one', 'The Listening Room'), item('book_fixture_two', 'A Second Chapter')];
const user = (name = 'demo') => ({ id: 'user_fixture', username: name, type: 'user', isActive: true, mediaProgress: [], bookmarks: [], seriesHideFromContinueListening: [], permissions: { accessAllLibraries: true, accessExplicitContent: true, update: false, delete: false, download: false, upload: false }, librariesAccessible: [] });
const service: any = { parties: new Map(), authorize: async (capability: string) => { const viewer = viewers.get(capability); if (!viewer || viewer.revoked) throw new Error('Revoked fixture'); return viewer; }, json: async () => user(), requireViewerItems: async () => {}, requirePartyItems: async () => {}, active: (viewer: any) => !viewer.revoked };
const coordinator = new ActivityPlaybackCoordinator(service);
function connection(owner: string, kind = 'personal') { const value = { id: owner.replace(/[^a-z0-9]/gi, '').padEnd(32, '0').slice(0,32), serverId: 'fixture-server', audiobookshelfUserId: 'user_fixture', audiobookshelfUsername: kind === 'community' ? 'Community' : 'demo', kind, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; connections.set(owner, value); return value; }
function wave() { const rate = 16000, count = rate * 60, buffer = Buffer.alloc(44 + count * 2); buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(count * 2, 40); for (let i = 0; i < count; i++) buffer.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 220) * 500), 44 + i * 2); return buffer; }
const tone = wave();
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', origin), pathname = url.pathname;
    const token = (req.headers.authorization || '').replace('Bearer ', ''), owner = token || 'host';
    let body: any = undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') { const chunks = []; for await (const chunk of req) chunks.push(chunk); const raw = Buffer.concat(chunks).toString(); if (raw) body = JSON.parse(raw); }
    const json = (value: any, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (pathname === '/api/config') return json({ publicBaseUrl: origin, publicDiscordClientId: 'fixture-app' });
    if (pathname === '/api/discord/exchange') return json({ appToken: body.mockUser?.id || 'fixture-host', discordAccessToken: 'fixture-oauth', user: body.mockUser || { id: 'host', username: 'Host' }, expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString() });
    if (pathname === '/api/connections' && req.method === 'GET') return json({ connections: connections.has(owner) ? [connections.get(owner)] : [], preferredConnectionId: preferences.get(owner) || null, communityAvailable: true, passwordEnabled: process.env.FIXTURE_OIDC_ONLY !== 'true', oidcEnabled: true });
    if (pathname === '/api/connections' && req.method === 'POST') { if (body.username !== 'demo' || body.password !== 'demo') return json({ error: { code: 'invalid_credentials', message: 'Use demo / demo for this synthetic fixture.' } }, 401); return json({ connection: connection(owner) }); }
    if (pathname === '/api/connections/community') return json({ connection: connection(owner, 'community') });
    if (pathname === '/api/connections/preference') { preferences.set(owner, body.connectionId); return json({ ok: true }); }
    if (pathname.startsWith('/api/connections/') && req.method === 'DELETE') { connections.delete(owner); preferences.delete(owner); return json({ ok: true }); }
    if (pathname === '/api/connections/oidc') return json({ id: 'fixture-oidc', url: `${origin}/fixture-sso`, expiresAt: new Date(Date.now()+60000).toISOString() });
    if (pathname.endsWith('/oidc/fixture-oidc/poll')) return json({ status: 'connected', connection: connection(owner) });
    if (pathname === '/fixture-sso') { res.end('Synthetic SSO fixture only. Return to the Activity.'); return; }
    if (pathname === '/api/party') { if (req.method === 'POST' && !party) { party = { id: 'fixture-party', instanceId: 'fixture-instance', guildId: 'dev-guild-1', channelId: 'dev-channel-1', serverId: 'fixture-server', groupId: 'fixture-epoch', queueItemIds: [] }; service.parties.set(party.id, party); } return json({ party }); }
    if (pathname === '/api/native/launch') { const capability = `fixture-${owner}-${Date.now()}`; const viewer = { capability, partyId: party.id, deviceId: body.deviceId, sockets: 0, joined: false, revoked: false }; viewers.set(capability, viewer); return json({ baseUrl: `/abs/${capability}`, accessToken: capability, userId: 'user_fixture', serverId: 'fixture-server', deviceId: body.deviceId, groupId: party.groupId, restoreRoute: null }); }
    if (pathname === '/api/native/restore' || pathname === '/api/logout') return json({ ok: true });
    const gateway = /^\/abs\/([^/]+)(\/.*)$/.exec(pathname);
    if (gateway) {
      const viewer = viewers.get(gateway[1]); if (!viewer) return json({ error: { code: 'native_session_expired', message: 'Fixture session missing' } }, 401);
      const route = gateway[2];
      if (route === '/Activity/Playback') return json(await coordinator.get(viewer));
      if (route === '/api/me') return json(user());
      if (route === '/api/libraries') return json({ libraries: [library] });
      if (route === `/api/libraries/${library.id}`) return json({ library, filterdata: { authors: [], genres: [], tags: [], series: [], narrators: [], languages: ['English'] }, issues: 0, numUserPlaylists: 0 });
      if (route.endsWith('/personalized')) return json([{ id: 'recently-added', type: 'book', label: 'Recently Added', entities: items, total: items.length }]);
      if (route.endsWith('/items')) return json({ results: items, total: items.length, limit: 100, page: 0, mediaType: 'book', minified: true });
      if (route.endsWith('/search')) return json({ book: items.map(libraryItem => ({ libraryItem })), tags: [], authors: [], series: [] });
      if (route.endsWith('/cover')) { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#385a63"/><text x="30" y="160" font-family="sans-serif" font-size="35" fill="white">Listening</text><text x="30" y="210" font-family="sans-serif" font-size="35" fill="white">together</text></svg>'); return; }
      const id = route.match(/^\/api\/items\/([^/]+)$/)?.[1]; if (id) return json(items.find(value => value.id === id) || items[0]);
      const play = route.match(/^\/api\/items\/([^/]+)\/play/); if (play) { const id = `fixture-session-${++sessionNumber}`, libraryItem = items.find(value => value.id === play[1]) || items[0]; sessions.set(id, { viewer, libraryItem }); return json({ id, libraryItemId: libraryItem.id, libraryItem, episodeId: null, currentTime: 0, duration: 120, playMethod: 0, displayTitle: libraryItem.media.metadata.title, displayAuthor: 'Test Library', audioTracks: [0,1].map(index => ({ index, startOffset: index * 60, duration: 60, title: `Track ${index+1}`, mimeType: 'audio/wav', contentUrl: `/public/session/${id}/track/${index}` })) }); }
      if (/^\/api\/session\/[^/]+\/(sync|close)$/.test(route)) return json({ success: true });
      if (route.startsWith('/public/session/')) { const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || ''); const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), tone.length - 1) : tone.length - 1; res.writeHead(range ? 206 : 200, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': end-start+1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${tone.length}` } : {}) }); res.end(tone.subarray(start,end+1)); return; }
      if (route.startsWith('/api/me/item/') && route.includes('/bookmark')) return json({ bookmarks: [] });
      if (route.includes('/series') || route.includes('/authors') || route.includes('/collections') || route.includes('/playlists')) return json({ results: [], total: 0 });
      console.info('Unimplemented synthetic native route', route); return json({ error: { message: 'Synthetic fixture route unavailable' } },404);
    }
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (relative.includes('..')) { res.writeHead(400).end(); return; }
    let content = await readFile(path.join(root, relative));
    if (relative === 'activity-session.js' && process.env.FIXTURE_PRESENCE === 'true') {
      // A synthetic SDK receiver tests the compiled native player-to-presence path.
      // It never connects to Discord and is served only by this local fixture.
      content = Buffer.concat([content, Buffer.from(`
;(() => {
  const fixtureErrors = [];
  const reportError = message => {
    fixtureErrors.push(String(message).slice(0, 500));
    let panel = document.getElementById('fixture-errors');
    if (!panel) { panel = document.createElement('output'); panel.id = 'fixture-errors'; panel.setAttribute('role', 'alert'); panel.style.cssText = 'position:fixed;bottom:0;right:0;z-index:99999;background:#501010;color:white;padding:8px;font-size:12px;max-width:400px'; document.body.append(panel); }
    panel.textContent = 'Synthetic fixture errors: ' + fixtureErrors.join(' | ');
  };
  window.addEventListener('error', event => reportError(event.message + ' at ' + (event.filename || '') + ':' + event.lineno));
  window.addEventListener('unhandledrejection', event => reportError(event.reason instanceof Error ? event.reason.message : 'Unhandled promise rejection'));
  const broker = window.AudiobookshelfWatch, original = broker.createWatchPresence;
  window.__presenceCalls = [];
  const sdk = { commands: { setActivity: async payload => {
    window.__presenceCalls.push(payload);
    let panel = document.getElementById('fixture-presence');
    if (!panel) { panel = document.createElement('output'); panel.id = 'fixture-presence'; panel.setAttribute('role', 'status'); panel.style.cssText = 'position:fixed;top:0;right:0;z-index:99999;background:#111;color:white;padding:8px;font-size:12px;max-width:360px'; document.body.append(panel); }
    panel.textContent = 'Synthetic Discord status: ' + (payload.activity ? payload.activity.details + ' / ' + payload.activity.state : 'cleared');
    return {};
  } } };
  broker.createWatchPresence = context => original({ ...context, isMock: false, isStandalone: false,
    grantedScopes: ['identify', 'rpc.activities.write'], sdk,
    application: { id: '1234567890', icon: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
})();
`)]);
    }
    const type = ({ '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.woff2':'font/woff2' } as any)[path.extname(relative)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, ...(process.env.FIXTURE_CSP === 'true' ? { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws:; font-src 'self' data:; object-src 'none'; base-uri 'self'" } : {}) }); res.end(content);
  } catch (error) { console.info('Fixture error', error instanceof Error ? error.message : 'unknown'); res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Fixture error"}}'); }
});
const ws = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => { const capability = req.url?.match(/^\/abs\/([^/]+)\/socket$/)?.[1], viewer = viewers.get(capability || ''); if (!viewer) { socket.destroy(); return; } ws.handleUpgrade(req,socket,head,(client: any) => { viewer.sockets++; let disconnect: any; void coordinator.connect(viewer, state => client.send(JSON.stringify({ MessageType:'ActivityPlaybackState', Data:state }))).then(value => { disconnect = value; }); client.on('message', async (raw: Buffer) => { try { const message=JSON.parse(raw.toString()); const state = await coordinator.submit(viewer,message.Data); client.send(JSON.stringify({ MessageType:'ActivityPlaybackState', Data:state })); } catch (error: any) { client.send(JSON.stringify({ MessageType:'ActivityPlaybackError', Data:{ id: JSON.parse(raw.toString()).Data?.id, code:error.code || 'fixture_error', ...(await coordinator.get(viewer)) } })); } }); client.on('close', () => { viewer.sockets--; disconnect?.(); }); }); });
server.listen(PORT,HOST,()=>console.info(`Synthetic native fixture ready: ${origin}/?mockUser=host (demo/demo or community)`));
