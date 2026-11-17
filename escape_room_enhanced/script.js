"use strict";
const $ = s => document.querySelector(s);
const clamp = (v,a,b)=>Math.min(Math.max(v,a),b);
const clean = v=>v.toUpperCase().replace(/[^A-Z0-9]/g,"");
const valid = v=>/^[A-Z0-9]{4}$/.test(v);
const HEADSTART=60, THRESH=1.15;
let stepLength=0.65;
let socket=null, role=null, code=null, trackerCode=null, state=null, joined=false, audioReady=false;
let me={x:3,y:3}, heading=0, compass=null, filteredCompass=null, headingOffset=0, pending={x:0,y:0};
let sensorOn=false, baseline=9.81, smooth=0, prev=0, lastStep=0, lastSend=0, lastLoop=performance.now();
let keysDown=new Set(), tool="key", drag=null, mapObj=null, monitorTimer=null;
const mapMargin=0.7;
let backgroundMusic = null;
function ensureSocket(){if(!socket)socket=io({reconnection:true});return socket;}
function connect(cb){const so=ensureSocket();if(cb){if(so.connected)cb();else so.once("connect",cb);}return so;}
function emitControl(action,extra={}){if(socket&&socket.connected)socket.emit("control",{action,...extra});}
function wake(){try{navigator.wakeLock?.request("screen");}catch(e){}}
document.addEventListener("visibilitychange",()=>{if(!document.hidden){wake();try{if(Tone?.context.state!=="running")Tone.context.resume();}catch(e){}}});

function mapCreate(canvas){return {cv:canvas,ctx:canvas.getContext("2d"),w:0,h:0,scale:1,room:{w:6,h:6}};}
function mapFit(M,room){
 const avail=M.cv.parentElement.clientWidth-32, ww=room.w+2*mapMargin,hh=room.h+2*mapMargin;
 const w=Math.min(Math.max(200,avail),680),h=Math.min(w*hh/ww,580),sc=Math.min(w/ww,h/hh);
 const cw=ww*sc,ch=hh*sc;if(M.w===cw&&M.h===ch&&M.room.w===room.w&&M.room.h===room.h)return;
 const dpr=devicePixelRatio||1;M.cv.style.width=cw+"px";M.cv.style.height=ch+"px";M.cv.width=cw*dpr;M.cv.height=ch*dpr;
 M.ctx.setTransform(dpr,0,0,dpr,0,0);M.w=cw;M.h=ch;M.scale=sc;M.room={...room};
}
const mx=(M,x)=>(x+mapMargin)*M.scale,my=(M,y)=>(M.room.h-y+mapMargin)*M.scale;
function mapPos(M,e){const r=M.cv.getBoundingClientRect(),px=e.clientX-r.left,py=e.clientY-r.top;return{x:px/M.scale-mapMargin,y:M.room.h+mapMargin-py/M.scale};}
function drawMap(M,st){
 if(!M||!st)return;mapFit(M,st.room);const c=M.ctx,R=st.room,sc=M.scale;c.clearRect(0,0,M.w,M.h);c.fillStyle="#14171d";c.fillRect(0,0,M.w,M.h);
 const x=mx(M,0),y=my(M,R.h);c.fillStyle="#1b1f27";c.fillRect(x,y,R.w*sc,R.h*sc);
 c.strokeStyle="#cfd5e388";c.setLineDash([7,5]);c.strokeRect(x,y,R.w*sc,R.h*sc);c.setLineDash([]);
 c.fillStyle="#98a0b3";c.font="600 11px system-ui";c.textAlign="center";c.fillText("TOP WALL",x+R.w*sc/2,y-6);
 const dot=(p,col,label,r=13)=>{if(!p)return;c.beginPath();c.arc(mx(M,p.x),my(M,p.y),r,0,Math.PI*2);c.fillStyle=col;c.fill();c.lineWidth=2;c.strokeStyle="#0e1015";c.stroke();c.fillStyle="#0e1015";c.font="800 12px system-ui";c.textBaseline="middle";c.fillText(label,mx(M,p.x),my(M,p.y)+1);c.textBaseline="alphabetic";};
 (st.keys||[]).forEach((k,i)=>dot(k,k.collected?"#515968":"#ffbd38",k.collected?"✓":"K"+(i+1),k.collected?10:12));
 dot(st.exit,"#3ddc84","EXIT",15);dot(st.escapee,"#ff7a3d","E",15);dot(st.chaser,"#61a7ff","C",15);
}
function trackerState(st){
 state=st;drawMap(mapObj,st);
 $("#t-countdown").textContent=st.phase==="headstart"?st.countdown:"—";
 const labels={setup:"Ready to set up",headstart:"Escapee head start",chase:"Chase is live",paused:"Paused",escaped:"Escapee reached the exit!",caught:"Chaser caught the escapee"};
 $("#t-status").textContent=labels[st.phase]||st.phase;$("#t-status").className="status "+(["escaped"].includes(st.phase)?"win":st.phase==="chase"?"live":"");
 $("#t-keys").textContent=`${st.keys.length-st.keysLeft} / ${st.keys.length} keys collected · ${st.keysLeft} remaining`;
 $("#t-players").textContent=`Escapee phone: ${st.escapee.live?"connected":"waiting"} · Chaser phone: ${st.chaser.live?"connected":"waiting"}`;
}
function startTracker(){
 $("#home").hidden=true;$("#tracker").hidden=false;mapObj=mapCreate($("#map"));wake();
 const so=ensureSocket();so.on("connect",()=>so.emit("tracker_open",{code:trackerCode}));
 so.off("opened").on("opened",m=>{trackerCode=m.code;$("#t-code").textContent=m.code;});
 so.off("state").on("state",trackerState);
 const cv=mapObj.cv;
 cv.addEventListener("pointerdown",e=>{
  if(!state)return;const p=mapPos(mapObj,e),near=(q)=>q?Math.hypot(mx(mapObj,p.x)-mx(mapObj,q.x),my(mapObj,p.y)-my(mapObj,q.y)):Infinity;
  const ds=near(state.escapee),dc=near(state.chaser);
  if(Math.min(ds,dc)<25){drag=ds<dc?"escapee":"chaser";try{cv.setPointerCapture(e.pointerId)}catch(_){};return;}
  if(tool==="exit")emitControl("place_exit",p);else emitControl("add_key",p);
 });
 cv.addEventListener("pointermove",e=>{if(!drag||!state)return;const p=mapPos(mapObj,e);emitControl("place_player",{role:drag,x:p.x,y:p.y});});
 ["pointerup","pointercancel"].forEach(ev=>cv.addEventListener(ev,()=>drag=null));
 $("#t-tool-key").onclick=()=>{tool="key";$("#t-tool-key").className="primary";$("#t-tool-exit").className="";};
 $("#t-tool-exit").onclick=()=>{tool="exit";$("#t-tool-exit").className="primary";$("#t-tool-key").className="";};
 $("#t-undo").onclick=()=>emitControl("remove_key");$("#t-clear").onclick=()=>emitControl("clear_keys");
 const room=()=>emitControl("room",{w:+$("#t-roomw").value||6,h:+$("#t-roomh").value||6});
 $("#t-roomw").onchange=room;$("#t-roomh").onchange=room;
 $("#t-start").onclick=()=>emitControl("start");$("#t-pause").onclick=()=>emitControl("pause");$("#t-reset").onclick=()=>emitControl("reset");
 window.addEventListener("resize",()=>{mapObj.w=0;if(state)drawMap(mapObj,state);});
}
function joinPhone(which){
 role=which;$("#home").hidden=true;$("#phone").hidden=false;$("#p-title").textContent=which==="escapee"?"Escapee":"Chaser";
 $("#p-join").hidden=false;$("#p-live").hidden=true;$("#p-code").value=new URLSearchParams(location.search).get("room")||"";
 $("#p-code").oninput=()=>$("#p-code").value=clean($("#p-code").value);
 $("#p-joinbtn").onclick=async()=>{
  code=clean($("#p-code").value);if(!valid(code)){$("#p-error").textContent="Enter the four-character code shown on the laptop." ;$("#p-error").hidden=false;return;}
  try{await initAudio();}catch(e){$("#p-error").textContent=e.message;$("#p-error").hidden=false;}
  wake();connect(()=>socket.emit("join",{code,role}));
 };
 const so=ensureSocket();
 so.off("joined");so.off("join_error");so.off("state");
 so.on("joined",m=>{joined=true;me={x:m.x,y:m.y};$("#p-join").hidden=true;$("#p-live").hidden=false;});
 so.on("join_error",m=>{$("#p-error").textContent=m.message;$("#p-error").hidden=false;});
 so.on("state",st=>{state=st;renderPhone(st);});
 so.on("set_pos",p=>{me={x:p.x,y:p.y};pending={x:0,y:0};});
 $("#p-sensors").onclick=enableSensors;$("#p-calibrate").onclick=calibrate;
 const stepControl=$("#p-step-length");
 stepControl.oninput=()=>{stepLength=Number(stepControl.value);$("#p-step-value").textContent=stepLength.toFixed(2)+" m";};
 $("#p-audio").onclick=async()=>{try{await initAudio();audioReady=true;$("#p-audio").textContent="Horror music and proximity sounds enabled";if(state)audioUpdate(state);}catch(e){alert(e.message);}};
}
function renderPhone(st){
 const phase=st.phase;
 let title=phase==="headstart"?(role==="escapee"?"GO!":"60") : phase==="chase"?"CHASE":phase==="escaped"?"ESCAPED":phase==="caught"?"CAUGHT":phase==="paused"?"PAUSED":"READY";
 if(phase==="headstart"&&role==="chaser")title=String(st.countdown);
 $("#p-phase").textContent=title;
 const msg=phase==="headstart"?(role==="chaser"?"Stay still. The chase begins when the countdown reaches zero.":"Collect the keys and find the exit before the chaser starts."):
 phase==="chase"?(role==="chaser"?"Follow the music to the escapee.":"Collect every key, then follow the music to the exit."):
 phase==="escaped"?"You escaped!":phase==="caught"?"The chaser caught you.":phase==="paused"?"The game is paused.":"Waiting for the laptop to start.";
 $("#p-message").textContent=msg;
 $("#p-progress").textContent=`Keys: ${st.keys.length-st.keysLeft}/${st.keys.length} collected · ${st.keysLeft} remaining`;
 audioUpdate(st);
}
async function enableSensors(){
 try{
  const ask=C=>typeof C!=="undefined"&&typeof C.requestPermission==="function"?C.requestPermission():"granted";
  const [m,o]=await Promise.all([ask(DeviceMotionEvent),ask(DeviceOrientationEvent)]);
  if(m!=="granted"||o!=="granted")alert("Motion permission was not granted. Check browser settings.");
 }catch(e){alert("Sensor permission: "+e.message);}
 if(!sensorOn){addEventListener("devicemotion",onMotion);addEventListener("deviceorientation",onOrient,true);addEventListener("deviceorientationabsolute",onOrient,true);}
 sensorOn=true;$("#p-sensors").textContent="Walking sensors enabled";wake();
}
function onOrient(e){
 let raw=null;
 if(typeof e.webkitCompassHeading==="number")raw=e.webkitCompassHeading;
 else if(e.alpha!=null&&(e.absolute||e.type==="deviceorientationabsolute"))raw=(360-e.alpha)%360;
 if(raw===null)return;
 if(filteredCompass===null)filteredCompass=raw;
 else{const delta=((raw-filteredCompass+540)%360)-180;filteredCompass=(filteredCompass+delta*.22+360)%360;}
 compass=filteredCompass;
}
function onMotion(e){
 const a=e.accelerationIncludingGravity;if(!a||a.x==null)return;const mag=Math.hypot(a.x,a.y,a.z);
 baseline+=(mag-baseline)*.02;smooth+=(mag-baseline-smooth)*.4;const now=performance.now();
 if(prev<THRESH&&smooth>=THRESH&&now-lastStep>350){
  lastStep=now;const h=compass!==null?(compass-headingOffset)*Math.PI/180:heading;
  pending.x+=stepLength*Math.sin(h);pending.y+=stepLength*Math.cos(h);
 }
 prev=smooth;
}
function calibrate(){if(compass!==null)headingOffset=compass;const r=state?.room||{w:6,h:6};me={x:r.w/2,y:r.h/2};pending={x:0,y:0};heading=0;sendPos(true);$("#p-calibrate").textContent="Calibrated · tap again to re-centre";}
function sendPos(force=false){
 const now=performance.now();if(!joined||!socket?.connected||(!force&&now-lastSend<100))return;lastSend=now;
 socket.emit("move",{x:me.x,y:me.y,heading});
}
function phoneLoop(){
 const now=performance.now(),dt=Math.min(.1,(now-lastLoop)/1000);lastLoop=now;if(!joined)return;
 const r=state?.room||{w:6,h:6};
 if(sensorOn){if(compass!==null)heading=(compass-headingOffset)*Math.PI/180;const len=Math.hypot(pending.x,pending.y);if(len>0){const mv=Math.min(len,(stepLength/.5)*dt),ux=pending.x/len,uy=pending.y/len;me.x=clamp(me.x+ux*mv,-.5,r.w+.5);me.y=clamp(me.y+uy*mv,-.5,r.h+.5);pending.x-=ux*mv;pending.y-=uy*mv;}}
 let dx=0,dy=0;if(keysDown.has("ArrowLeft")||keysDown.has("a"))dx--;if(keysDown.has("ArrowRight")||keysDown.has("d"))dx++;if(keysDown.has("ArrowUp")||keysDown.has("w"))dy++;if(keysDown.has("ArrowDown")||keysDown.has("s"))dy--;
 const mag=Math.hypot(dx,dy);if(mag){me.x=clamp(me.x+dx/mag*1.2*dt,-.5,r.w+.5);me.y=clamp(me.y+dy/mag*1.2*dt,-.5,r.h+.5);if(!sensorOn||compass===null)heading=Math.atan2(dx,dy);}
 sendPos();
}
addEventListener("keydown",e=>{const k=e.key.length===1?e.key.toLowerCase():e.key;keysDown.add(k);if(k.startsWith("Arrow"))e.preventDefault();});
addEventListener("keyup",e=>keysDown.delete(e.key.length===1?e.key.toLowerCase():e.key));
addEventListener("blur",()=>keysDown.clear());
setInterval(phoneLoop,50);

let synth=null,pan=null,keySynth=null,keyPan=null,footSynth=null,footPan=null;
let ambienceA=null,ambienceB=null,ambientSynth=null,nextAmbientAt=0,ambientNoteIndex=0,nextFootAt=0,nextPianoAt=0,lastCountdown=0;
function stopAmbience(){
 [ambienceA,ambienceB].forEach(o=>{if(o){try{o.stop();o.dispose();}catch(e){}}});
 ambienceA=ambienceB=null;
}
function startAmbience(){
 if(ambienceA||!window.Tone)return;
 // Original, generated low horror drone — no recorded or copyrighted music.
 ambienceA=new Tone.Oscillator(55,"sine").toDestination();
 ambienceB=new Tone.Oscillator(82.41,"sine").toDestination();
 ambienceA.volume.value=-29;ambienceB.volume.value=-35;
 ambienceA.start();ambienceB.start();
}

async function initAudio(){
 await Tone.start();

 // Start the looping horror soundtrack
 if(!backgroundMusic){
  backgroundMusic = new Audio("/static/audio/background.mp3");
  backgroundMusic.loop = true;
  backgroundMusic.volume = 0.4;
 }

 await backgroundMusic.play();

 if(audioReady) return;

 if(!window.Tone) throw new Error("Tone.js could not load. Check your internet connection.");

 synth=new Tone.Synth({oscillator:{type:"sine"},envelope:{attack:.01,decay:.12,sustain:0,release:.08}});
 pan=new Tone.Panner(0).toDestination();synth.connect(pan);

 ambientSynth=new Tone.Synth({oscillator:{type:"sine"},envelope:{attack:.12,decay:.8,sustain:.05,release:1.1}}).toDestination();
 ambientSynth.volume.value=-24;

 keySynth=new Tone.Synth({oscillator:{type:"triangle"},envelope:{attack:.005,decay:.35,sustain:.02,release:.45}});
 keyPan=new Tone.Panner(0).toDestination();keySynth.connect(keyPan);

 footSynth=new Tone.MembraneSynth({pitchDecay:.035,octaves:2,oscillator:{type:"sine"},envelope:{attack:.001,decay:.16,sustain:0,release:.01}});
 footPan=new Tone.Panner(0).toDestination();footSynth.connect(footPan);

 audioReady=true;
 $("#p-audio").textContent="Horror music and proximity sounds enabled";
}

function audioUpdate(st){
 if(!audioReady||!joined)return;
 const active=st.phase==="headstart"||st.phase==="chase";
 if(active)startAmbience();else stopAmbience();
 if(!active)return;
 const now=performance.now();
 // A slow, original minor-key motif sits over the low drone.
 if(now>=nextAmbientAt){
  const motif=["A3","C4","E3","Bb3","G3","D4"];
  ambientSynth.triggerAttackRelease(motif[ambientNoteIndex%motif.length],"2n",undefined,.38);
  ambientNoteIndex++;nextAmbientAt=now+1850;
 }
 if(st.phase==="headstart"&&role==="chaser"){
  if(st.countdown!==lastCountdown){lastCountdown=st.countdown;if(st.countdown%10===0||st.countdown<=5)synth.triggerAttackRelease(st.countdown<=5?"C5":"G4","16n");}
 }
 // Escapee gets a directional piano beacon for the next key (or the exit).
 if(role==="escapee"){
  const target=st.keys.find(k=>!k.collected)||st.exit;
  const keyDistance=Math.hypot(me.x-target.x,me.y-target.y);
  const angle=Math.atan2(target.x-me.x,target.y-me.y)-heading;
  keyPan.pan.rampTo(clamp(Math.sin(angle),-1,1),.15);
  const closeness=clamp((6-keyDistance)/6,0,1);
  const pianoInterval=1.65-closeness*1.25;
  if(now>=nextPianoAt){
   const note=keyDistance<.5?"E6":keyDistance<1.2?"C6":keyDistance<2.5?"G5":keyDistance<4?"E5":"C5";
   keySynth.triggerAttackRelease(note,"8n",undefined,.55);
   nextPianoAt=now+pianoInterval*1000;
  }
 }
 // Both players hear footsteps that accelerate as the gap closes.
 if(st.phase==="chase"){
  const other=role==="escapee"?st.chaser:st.escapee;
  const distance=Number.isFinite(st.chaserDistance)?st.chaserDistance:Math.hypot(me.x-other.x,me.y-other.y);
  const angle=Math.atan2(other.x-me.x,other.y-me.y)-heading;
  footPan.pan.rampTo(clamp(Math.sin(angle),-1,1),.12);
  const urgency=clamp((8-distance)/8,0,1);
  const footInterval=2.15-urgency*1.78;
  if(now>=nextFootAt){
   const pitch=distance<1.2?"C3":distance<3?"A2":"F2";
   footSynth.triggerAttackRelease(pitch,"8n",undefined,.75);
   nextFootAt=now+footInterval*1000;
  }
 }
}
function boot(){
 $("#go-tracker").onclick=startTracker;$("#go-escapee").onclick=()=>joinPhone("escapee");$("#go-chaser").onclick=()=>joinPhone("chaser");
 $("#t-back").onclick=$("#p-back").onclick=()=>location.href=location.pathname;
 const q=new URLSearchParams(location.search),r=q.get("role"),room=q.get("room");
 if(r==="tracker")startTracker();else if(r==="escapee"||r==="chaser"){joinPhone(r);if(room)$("#p-code").value=clean(room);}
}
document.addEventListener("DOMContentLoaded",boot);
