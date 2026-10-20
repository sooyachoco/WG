// 100m 결승전 온라인 방 서버 — 방 코드마다 Durable Object 하나가 경기 진행을 맡음
import { DurableObject } from 'cloudflare:workers';

// 클라이언트(index.html)의 PHYS / ROSTER 와 같은 값이어야 함
const PHYS = {impulse:1.7, vcap:12.6, drag:0.3, fatigue:0.12, kStart:0.06, kSprint:0.12, kStamina:0.055};
const STATS = [[7,5,3],[3,5,7],[4,7,4],[5,5,5],[6,6,3],[6,3,6],[3,6,6],[4,4,7]];
const NAMES = ['번개 두식','헐떡 박사','치타 쭈니','열혈 한결','근육 마초','깜빡 미미','졸린 곰돌','울보 철수'];
const LANE_ORDER = [3, 4, 2, 5, 1, 6, 0, 7];   // 사람은 가운데 레인부터
const MAX_PLAYERS = 8;
const MAX_V = 13.5, MIN_TIME = 9.0;

// AI 기록은 서버가 고정 스텝으로 계산해서 결과의 기준으로 씀
function simAI(stats, rate, react, seed){
  let x = 0, v = 0, t = 0; const dt = 1/120;
  while (x < 100 && t < 40){
    t += dt;
    if (t > react){
      const r = rate*(1 + 0.05*Math.sin(t*2.3 + seed));
      const imp = PHYS.impulse*(x < 30 ? 1 + (stats[0] - 5)*PHYS.kStart : 1);
      const vcap = PHYS.vcap + (stats[1] - 5)*PHYS.kSprint;
      v += r*imp*Math.max(0, 1 - v/vcap)*dt;
    }
    const drag = PHYS.drag + (x > 50 ? Math.min(1, (x - 50)/50)*(PHYS.fatigue - (stats[2] - 5)*PHYS.kStamina) : 0);
    v = Math.max(0, v - (v*drag + 0.15)*dt);
    x += v*dt;
  }
  return t - (x - 100)/Math.max(v, 0.1);
}

export default {
  async fetch(req, env){
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/room\/([A-Z0-9]{4,6})$/);
    if (m){
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket only', {status: 426});
      try { return await env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req); }
      catch (e){ console.error('stub error', e && e.stack || e); return new Response('stub error', {status: 500}); }
    }
    return new Response('100m room server', {headers: {'content-type': 'text/plain; charset=utf-8'}});
  },
};

export class Room extends DurableObject {
  constructor(ctx, env){
    super(ctx, env);
    this.players = new Map();
    this.phase = 'lobby';            // lobby → mark → set → race → results (false: 부정출발 대기)
    this.host = null;
    this.lineup = null;
    this.timers = [];
    this.tick = null;
    this.nextId = 1;
  }

  async fetch(req){
    try { return this.accept(req); }
    catch (e){ console.log('room error', e && e.stack); return new Response('room error', {status: 500}); }
  }

  accept(req){
    const url = new URL(req.url);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const name = (url.searchParams.get('name') || '선수').trim().slice(0, 8) || '선수';
    const char = Math.min(7, Math.max(0, parseInt(url.searchParams.get('char'), 10) || 0));

    if (this.players.size >= MAX_PLAYERS || !(this.phase === 'lobby' || this.phase === 'results')){
      server.send(JSON.stringify({t: 'err', msg: this.players.size >= MAX_PLAYERS ? '방이 꽉 찼어요 (최대 8명)' : '경기가 진행 중이에요. 끝난 뒤 다시 들어와 주세요.'}));
      server.close(4000, 'busy');
      return new Response(null, {status: 101, webSocket: client});
    }

    const p = {id: 'p' + this.nextId++, ws: server, name, char, x: 0, v: 0, finished: false, time: null, lastPos: 0, seen: Date.now()};
    this.players.set(p.id, p);
    if (!this.host) this.host = p.id;
    server.addEventListener('message', e => this.onMsg(p, e.data));
    const bye = () => this.leave(p);
    server.addEventListener('close', bye);
    server.addEventListener('error', bye);
    // 조용히 죽은 연결(유령 방장 등)을 주기적으로 정리
    if (!this.reaper) this.reaper = setInterval(() => this.reap(), 10000);
    this.send(p, {t: 'welcome', you: p.id});
    this.broadcastLobby();
    return new Response(null, {status: 101, webSocket: client});
  }

  onMsg(p, raw){
    p.seen = Date.now();
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.t){
      case 'start':  if (p.id === this.host && (this.phase === 'lobby' || this.phase === 'results')) this.startRace(); break;
      case 'false':  if (this.phase === 'set') this.falseStart(p); break;
      case 'pos':    if (this.phase === 'race' && !p.finished) this.onPos(p, Number(m.x), Number(m.v)); break;
      case 'finish': if (this.phase === 'race' && !p.finished) this.onFinish(p, Number(m.time)); break;
      case 'ping':   this.send(p, {t: 'pong', c: m.c}); break;
    }
  }

  startRace(){
    this.clearTimers();
    const humans = [...this.players.values()];
    const lineup = new Array(8).fill(null);
    humans.forEach((p, i) => {
      lineup[LANE_ORDER[i]] = {id: p.id, name: p.name, char: p.char};
      Object.assign(p, {x: 0, v: 0, finished: false, time: null, lastPos: 0});
    });
    // 빈 레인은 사람이 고르지 않은 캐릭터의 AI로 채움
    const used = new Set(humans.map(p => p.char));
    const free = [0, 1, 2, 3, 4, 5, 6, 7].filter(c => !used.has(c)).sort(() => Math.random() - 0.5);
    let k = 0;
    for (let lane = 0; lane < 8; lane++){
      if (lineup[lane]) continue;
      const c = free[k++ % free.length];
      const ai = {rate: 9.2 + Math.random()*1.6, react: 0.12 + Math.random()*0.1, seed: Math.random()*10};
      lineup[lane] = {id: null, name: NAMES[c], char: c, ai, time: simAI(STATS[c], ai.rate, ai.react, ai.seed)};
    }
    this.lineup = lineup;
    this.mark();
  }

  mark(){
    this.clearTimers();
    for (const p of this.players.values()) Object.assign(p, {x: 0, v: 0, finished: false, time: null, lastPos: 0});
    this.phase = 'mark';
    this.broadcast({t: 'mark', lineup: this.lineup.map(({time, ...pub}) => pub)});
    this.later(1500, () => {
      this.phase = 'set';
      this.broadcast({t: 'set'});
      this.later(1000 + Math.random()*1200, () => this.bang());
    });
  }

  bang(){
    this.phase = 'race';
    this.bangAt = Date.now();
    this.broadcast({t: 'bang'});
    this.tick = setInterval(() => {
      if (!this.dirty) return;
      this.dirty = false;
      this.broadcast({t: 'pos', p: [...this.players.values()].map(p => [p.id, Math.round(p.x*100)/100, Math.round(p.v*100)/100])});
    }, 66);
    this.later(40000, () => this.finishRace());
  }

  falseStart(p){
    this.clearTimers();
    this.phase = 'false';
    this.broadcast({t: 'false', id: p.id});
    this.later(2400, () => this.mark());
  }

  onPos(p, x, v){
    if (!Number.isFinite(x) || !Number.isFinite(v)) return;
    const now = Date.now();
    const dt = p.lastPos ? Math.min(1, (now - p.lastPos)/1000) : 0.2;
    p.x = Math.min(Math.max(x, p.x), p.x + MAX_V*dt + 1);   // 순간이동 방지
    p.v = Math.min(Math.max(v, 0), MAX_V);
    p.lastPos = now;
    this.dirty = true;
  }

  onFinish(p, time){
    if (p.x < 95) return;                                   // 거의 다 와야 인정
    const elapsed = (Date.now() - this.bangAt)/1000;
    // 클라이언트 기록이 서버 경과 시간과 크게 다르면 서버 기준
    let t = Number.isFinite(time) && time >= MIN_TIME && Math.abs(time - elapsed) < 0.8 ? time : Math.max(MIN_TIME, elapsed);
    p.finished = true; p.time = Math.round(t*1000)/1000; p.x = 100;
    this.broadcast({t: 'fin', id: p.id, time: p.time});
    const all = [...this.players.values()].every(q => q.finished);
    if (all) this.later(1500, () => this.finishRace());
    else if (!this.fallback) this.fallback = this.later(10000, () => this.finishRace());
  }

  finishRace(){
    if (this.phase !== 'race') return;
    this.clearTimers();
    this.phase = 'results';
    const list = this.lineup.map((e, lane) => {
      const p = e.id ? this.players.get(e.id) : null;
      return {lane, id: e.id, name: e.name, char: e.char, time: e.id ? (p && p.finished ? p.time : null) : Math.round(e.time*1000)/1000};
    }).sort((a, b) => (a.time ?? 1e9) - (b.time ?? 1e9));
    this.broadcast({t: 'results', list});
    this.broadcastLobby();
  }

  leave(p){
    if (!this.players.has(p.id)) return;
    this.players.delete(p.id);
    if (this.host === p.id) this.host = this.players.keys().next().value ?? null;
    if (!this.players.size){ this.clearTimers(); this.phase = 'lobby'; return; }
    this.broadcast({t: 'left', id: p.id});
    if (this.phase === 'race' && [...this.players.values()].every(q => q.finished)) this.finishRace();
    else if (this.phase === 'mark' || this.phase === 'set' || this.phase === 'false'){
      // 출발 전 이탈: 그 레인은 비워 두고 계속
      this.lineup = this.lineup.map(e => e && e.id === p.id ? {...e, left: true} : e);
    }
    this.broadcastLobby();
  }

  reap(){
    const now = Date.now();
    for (const p of [...this.players.values()]){
      if (now - p.seen > 35000){ try { p.ws.close(4001, 'timeout'); } catch {} this.leave(p); }
    }
    if (!this.players.size && this.reaper){ clearInterval(this.reaper); this.reaper = null; }
  }

  broadcastLobby(){
    this.broadcast({t: 'lobby', host: this.host, phase: this.phase,
      players: [...this.players.values()].map(p => ({id: p.id, name: p.name, char: p.char}))});
  }
  later(ms, fn){ const id = setTimeout(fn, ms); this.timers.push(id); return id; }
  clearTimers(){
    this.timers.forEach(clearTimeout); this.timers = [];
    if (this.tick){ clearInterval(this.tick); this.tick = null; }
    this.fallback = null;
  }
  send(p, obj){ try { p.ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(obj){ const s = JSON.stringify(obj); for (const p of this.players.values()){ try { p.ws.send(s); } catch {} } }
}
