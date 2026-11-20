'use strict';

const SIDE = 48, PIXELS = SIDE * SIDE;
const MAX_BYTES = 30 * 1024 * 1024;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const AMINO = new Set('ALA ARG ASN ASP CYS GLN GLU GLY HIS ILE LEU LYS MET PHE PRO SER THR TRP TYR VAL MSE SEC PYL SEP TPO PTR HYP MLY CSO ASX GLX'.split(' '));
const RANK = {candidate: 2, uncertain: 1, none: 0};
const compare = (a,b) => RANK[b.status] - RANK[a.status] || b.ranking_score - a.ranking_score;

function collect(chains, {chain, residue, element, atom, occupancy, coords}) {
  if (!AMINO.has(element) || !['N','CA','C'].includes(atom) || !coords.every(Number.isFinite)) return;
  if (!chains.has(chain)) chains.set(chain, new Map());
  const residues = chains.get(chain);
  if (!residues.has(residue)) residues.set(residue, {});
  const entry = residues.get(residue);
  if (!entry[atom] || entry[atom].occupancy < occupancy) entry[atom] = {occupancy, coords};
}

function pdbChains(text) {
  const chains = new Map();
  for (const line of text.split(/\r?\n/)) {
    const record = line.slice(0,6).trim();
    if (record === 'ENDMDL') break;
    if (record !== 'ATOM' && record !== 'HETATM') continue;
    if (line.length < 54) continue;
    const coords = [line.slice(30,38), line.slice(38,46), line.slice(46,54)].map(s => s.trim() ? Number(s) : NaN);
    collect(chains,{chain:line.slice(21,22).trim() || '_',residue:line.slice(22,27),
      element:line.slice(17,20).trim().toUpperCase(),atom:line.slice(12,16).trim(),
      occupancy:Number(line.slice(54,60)) || 0,coords});
  }
  return chains;
}

function* cifTokens(text) {
  // Bare, quoted, comment and semicolon-block values have distinct CIF rules.
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c <= ' ') { i++; continue; }
    if (c === '#') { i = text.indexOf('\n', i); if (i < 0) return; continue; }
    if (c === ';' && (i === 0 || text[i-1] === '\n')) {
      const end = text.indexOf('\n;',i+1);
      if (end < 0) throw new Error('An mmCIF text block is incomplete.');
      yield {value: '', quoted: true};
      i = end+2;
      continue;
    }
    if (c === "'" || c === '"') {
      const start = ++i;
      while (i < text.length && !(text[i] === c && (i+1 === text.length || text[i+1] <= ' '))) i++;
      if (i === text.length) throw new Error('An mmCIF quoted field is incomplete.');
      yield {value:text.slice(start,i++),quoted:true};
      continue;
    }
    const start = i++;
    while (i < text.length && text[i] > ' ') i++;
    yield {value:text.slice(start,i),quoted:false};
  }
}

function cifChains(text) {
  const stream = cifTokens(text);
  let next = stream.next();
  const read = () => { const item = next; next = stream.next(); return item.value; };
  while (!next.done) {
    const token = read();
    if (token.quoted || token.value.toLowerCase() !== 'loop_') continue;
    const columns = [];
    while (!next.done && !next.value.quoted && next.value.value.startsWith('_')) columns.push(read().value.toLowerCase());
    if (!columns.some(c => c.startsWith('_atom_site.'))) continue;
    const index = new Map(columns.map((c,i)=>[c.slice('_atom_site.'.length),i]));
    for (const axis of ['cartn_x','cartn_y','cartn_z','label_atom_id']) {
      if (!index.has(axis)) throw new Error('The mmCIF atom table is missing coordinates or atom names.');
    }
    const chains = new Map();
    const row = new Array(columns.length);
    let firstModel;
    const get = name => row[index.get(name)];
    const auth = (first, second) => [get(first),get(second)].find(x => x && x !== '.' && x !== '?');
    const number = name => {
      const value = get(name);
      return value === '?' || value === '.' || !value ? NaN : Number(value);
    };
    while (!next.done) {
      if (!next.value.quoted && /^(?:_|loop_$|stop_$|data_|save_)/i.test(next.value.value)) break;
      for (let i=0;i<columns.length;i++) {
        if (next.done) throw new Error('The mmCIF atom table ends mid-row.');
        row[i] = read().value;
      }
      const model = get('pdbx_pdb_model_num') || '1';
      if (firstModel === undefined) firstModel = model;
      if (model !== firstModel) continue;
      const atom = get('label_atom_id');
      if (!['N','CA','C'].includes(atom)) continue;
      const seq = auth('auth_seq_id','label_seq_id');
      if (!seq) continue;
      collect(chains,{
        chain:auth('auth_asym_id','label_asym_id') || '_',
        residue:seq+'/'+(get('pdbx_pdb_ins_code') || ''),
        element:(auth('auth_comp_id','label_comp_id') || '').toUpperCase(),
        atom,occupancy:number('occupancy') || 0,
        coords:[number('cartn_x'),number('cartn_y'),number('cartn_z')]
      });
    }
    return chains;
  }
  throw new Error('No mmCIF atom table was found.');
}

function structureUnits(text, filename) {
  const data = /\.(?:cif|mmcif)$/i.test(filename) || /^\s*(?:#.*\n\s*)*data_/i.test(text) ? cifChains(text) : pdbChains(text);
  const units = [];
  for (const [chain,residues] of data) {
    const points = [], edges = [];
    for (const atoms of residues.values()) {
      if (!atoms.N || !atoms.C || !atoms.CA) continue;
      const point=atoms.CA.coords;
      if (points.length && Math.hypot(...point.map((x,i)=>x-points[points.length-1][i]))<4.6) {
        edges.push([points.length-1,points.length]);
      }
      points.push(point);
    }
    if (points.length>=30) units.push({name:'chain_'+chain,points,edges});
  }
  if (!units.length) throw new Error('No protein chain with at least 30 Cα atoms was found.');
  const total=units.reduce((n,u)=>n+u.points.length,0);
  if (units.length>28 || total>30000) throw new Error('This structure is too large for a browser scan. Try its individual chains.');
  if (units.length>1) {
    const whole={name:'whole',points:[],edges:[]};
    for (const unit of units) {
      const offset=whole.points.length;
      whole.points.push(...unit.points);
      for (const [a,b] of unit.edges) whole.edges.push([a+offset,b+offset]);
    }
    units.unshift(whole);
  }
  return units;
}

const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function multiply(a,b) { return a.map(row=>b[0].map((_,j)=>row.reduce((sum,v,k)=>sum+v*b[k][j],0))); }
function rotations(directions=24,rolls=8) {
  const orientations=[];
  for (let i=0;i<directions;i++) {
    const z=1-2*(i+.5)/directions, phi=i*Math.PI*(3-Math.sqrt(5)), radius=Math.sqrt(1-z*z);
    const n=[radius*Math.cos(phi),radius*Math.sin(phi),z];
    let x=cross(Math.abs(z)<.9?[0,0,1]:[0,1,0],n);
    const length=Math.hypot(...x);
    x=x.map(v=>v/length);
    const base=[x,cross(n,x),n];
    for (let j=0;j<rolls;j++) {
      const a=j*2*Math.PI/rolls,c=Math.cos(a),s=Math.sin(a);
      orientations.push(multiply([[c,-s,0],[s,c,0],[0,0,1]],base));
    }
  }
  return orientations;
}
function tilt(axis,angle) {
  const c=Math.cos(angle),s=Math.sin(angle);
  if (axis===0) return [[1,0,0],[0,c,-s],[0,s,c]];
  if (axis===1) return [[c,0,s],[0,1,0],[-s,0,c]];
  return [[c,-s,0],[s,c,0],[0,0,1]];
}

function projected(unit,matrix,size,pad) {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  const coordinates=unit.points.map(p=>{
    const x=dot(p,matrix[0]),y=dot(p,matrix[1]);
    minX=Math.min(minX,x); maxX=Math.max(maxX,x);
    minY=Math.min(minY,y); maxY=Math.max(maxY,y);
    return [x,y];
  });
  const scale=(size-2*pad)/Math.max(1e-6,maxX-minX,maxY-minY);
  return coordinates.map(([x,y])=>[(x-(minX+maxX)/2)*scale+size/2,(y-(minY+maxY)/2)*scale+size/2]);
}

function makeRasterizer() {
  if (typeof OffscreenCanvas !== 'function') throw new Error('This browser cannot render search previews. Use a current desktop browser.');
  const board=new OffscreenCanvas(96,96), small=new OffscreenCanvas(SIDE,SIDE);
  const ctx=board.getContext('2d',{willReadFrequently:true});
  const target=small.getContext('2d',{willReadFrequently:true});
  target.imageSmoothingEnabled=true; target.imageSmoothingQuality='high';
  return (unit,matrix)=>{
    const points=projected(unit,matrix,96,9);
    ctx.fillStyle='black';ctx.fillRect(0,0,96,96);
    ctx.strokeStyle='white';ctx.lineWidth=4;ctx.lineCap='round';ctx.lineJoin='round';
    ctx.beginPath();
    let end=-1;
    const connected=new Uint8Array(points.length);
    for (const [a,b] of unit.edges) {
      if (a!==end) ctx.moveTo(...points[a]);
      ctx.lineTo(...points[b]);
      end=b;connected[a]=connected[b]=1;
    }
    ctx.stroke();
    ctx.fillStyle='white';
    for (let i=0;i<points.length;i++) if (!connected[i]) {
      ctx.beginPath();ctx.arc(points[i][0],points[i][1],1.5,0,2*Math.PI);ctx.fill();
    }
    let left=96,right=0,top=96,bottom=0;
    const pixels=ctx.getImageData(0,0,96,96).data;
    for (let y=0;y<96;y++) for (let x=0;x<96;x++) if (pixels[(y*96+x)*4]>20) {
      left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
    }
    const values=new Float32Array(PIXELS);
    if (left>right) return values;
    const width=right-left+1,height=bottom-top+1,scale=40/Math.max(width,height);
    const w=Math.max(1,Math.round(width*scale)),h=Math.max(1,Math.round(height*scale));
    target.fillStyle='black';target.fillRect(0,0,SIDE,SIDE);
    target.drawImage(board,left,top,width,height,(SIDE-w)>>1,(SIDE-h)>>1,w,h);
    const normalized=target.getImageData(0,0,SIDE,SIDE).data;
    for (let j=0;j<PIXELS;j++) values[j]=normalized[4*j]/255;
    return values;
  };
}

function pixelDistances(mask) {
  const tmp=new Float32Array(PIXELS),dist=new Float32Array(PIXELS);
  const f=new Float64Array(SIDE), v=new Int16Array(SIDE), z=new Float64Array(SIDE+1);
  function transform() {
    let k=0; v[0]=0;z[0]=-Infinity;z[1]=Infinity;
    for (let p=1;p<SIDE;p++) {
      let q=v[k], s=((f[p]+p*p)-(f[q]+q*q))/(2*(p-q));
      while (s<=z[k]) { k--;q=v[k];s=((f[p]+p*p)-(f[q]+q*q))/(2*(p-q)); }
      v[++k]=p;z[k]=s;z[k+1]=Infinity;
    }
  }
  function pass(out,offset,step,squared) {
    let k=0;
    for (let p=0;p<SIDE;p++) {
      while (z[k+1]<p) k++;
      const d=p-v[k],value=d*d+f[v[k]];
      out[offset+p*step]=squared?value:Math.sqrt(value);
    }
  }
  for (let y=0;y<SIDE;y++) {
    for (let x=0;x<SIDE;x++) f[x]=mask[y*SIDE+x]?0:1000000;
    transform();pass(tmp,y*SIDE,1,true);
  }
  for (let x=0;x<SIDE;x++) {
    for (let y=0;y<SIDE;y++) f[y]=tmp[y*SIDE+x];
    transform();pass(dist,x,SIDE,false);
  }
  return dist;
}

const BLUR=[.004433048,.054005583,.242036229,.399050279,.242036229,.054005583,.004433048];
function soften(values) {
  const mid=new Float32Array(PIXELS),out=new Float32Array(PIXELS);
  for (let y=0;y<SIDE;y++) for (let x=0;x<SIDE;x++) {
    for (let d=-3;d<=3;d++) mid[y*SIDE+x]+=BLUR[d+3]*values[y*SIDE+Math.max(0,Math.min(SIDE-1,x+d))];
  }
  for (let y=0;y<SIDE;y++) for (let x=0;x<SIDE;x++) {
    for (let d=-3;d<=3;d++) out[y*SIDE+x]+=BLUR[d+3]*mid[Math.max(0,Math.min(SIDE-1,y+d))*SIDE+x];
  }
  return out;
}
function reference(values) {
  const mask=Uint8Array.from(values,v=>v>.25?1:0);
  return {mask,count:mask.reduce((a,b)=>a+b,0),dist:pixelDistances(mask),soft:soften(values)};
}
function similarity(view,targets) {
  if (!view.count) return 0;
  let best=0;
  for (const target of targets) {
    let from=0,to=0,min=0,total=0;
    for (let i=0;i<PIXELS;i++) {
      if (view.mask[i]) from+=target.dist[i];
      if (target.mask[i]) to+=view.dist[i];
      min+=Math.min(view.soft[i],target.soft[i]);
      total+=view.soft[i]+target.soft[i];
    }
    best=Math.max(best,.6*Math.exp(-(from/view.count+to/target.count)/5)+.8*min/Math.max(total,1e-9));
  }
  return best;
}

function makeInference(tf,metadata,weights) {
  const tensors=metadata.tensors.map(({shape,offset,length})=>tf.tensor(new Float32Array(weights,offset,length),shape));
  return function infer(values) {
    const batch=new Float32Array(values.length*PIXELS);
    values.forEach((v,i)=>batch.set(v,i*PIXELS));
    return tf.tidy(()=>{
      let x=tf.tensor4d(batch,[values.length,SIDE,SIDE,1]);
      for (let i=0;i<6;i+=2) x=tf.maxPool(tf.relu(tf.add(tf.conv2d(x,tensors[i],1,'same'),tensors[i+1])),2,2,'valid');
      x=tf.transpose(x,[0,3,1,2]).reshape([values.length,64*6*6]);
      x=tf.relu(tf.add(tf.matMul(x,tensors[6]),tensors[7]));
      return tf.softmax(tf.add(tf.matMul(x,tensors[8]),tensors[9])).dataSync();
    });
  };
}

let loaded;
function loadEngine() {
  if (!loaded) loaded=(async()=>{
    importScripts('./vendor/tfjs/tf.min.js','./vendor/tfjs/tf-backend-wasm.min.js');
    tf.wasm.setWasmPaths(new URL('./vendor/tfjs/',self.location.href).href);
    tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT',false);
    if (!await tf.setBackend('wasm')) throw new Error('The browser could not start the protein model.');
    await tf.ready();
    async function bytes(path,asJson=false) {
      const response=await fetch(path);
      if (!response.ok) throw new Error('The protein model could not be loaded.');
      return asJson?response.json():response.arrayBuffer();
    }
    const [meta,weights,refs]=await Promise.all([
      bytes('./scan-model/metadata.json',true),bytes('./scan-model/weights.bin'),bytes('./scan-model/templates.bin')
    ]);
    if (meta.version!==1 || meta.class_order.join('')!==ALPHABET+'none' || refs.byteLength!==26*8*PIXELS) {
      throw new Error('The protein model files are incompatible.');
    }
    const values=new Uint8Array(refs);
    const templates=Array.from(ALPHABET,(_,i)=>Array.from({length:8},(_,j)=>{
      const start=(i*8+j)*PIXELS;
      return reference(Float32Array.from(values.subarray(start,start+PIXELS),v=>v/255));
    }));
    return {infer:makeInference(tf,meta,weights),templates,raster:makeRasterizer(),coarse:rotations()};
  })().catch(error=>{loaded=null;throw error;});
  return loaded;
}

function searchUnit(unit,engine) {
  const matrices=engine.coarse.slice();
  const images=[], probabilities=[];
  function evaluate(start) {
    for (let i=start;i<matrices.length;i++) images.push(engine.raster(unit,matrices[i]));
    for (let i=start;i<matrices.length;i+=12) {
      const batch=images.slice(i,i+12),p=engine.infer(batch);
      for (let j=0;j<batch.length;j++) probabilities.push(p.slice(j*27,(j+1)*27));
    }
  }
  evaluate(0);
  const top=probabilities.map((p,index)=>({index,value:Math.max(...p.subarray(0,26))})).sort((a,b)=>b.value-a.value).slice(0,8);
  const firstFine=matrices.length;
  for (const {index} of top) for (const [axis,angle] of [[0,-.07],[0,.07],[1,-.07],[1,.07]]) {
    matrices.push(multiply(tilt(axis,angle),matrices[index]));
  }
  evaluate(firstFine);
  const features=new Map();
  const rows=[];
  for (let label=0;label<26;label++) {
    const indices=probabilities.map((_,i)=>i).sort((a,b)=>probabilities[b][label]-probabilities[a][label]).slice(0,2);
    const proposals=indices.map(index=>{
      if (!features.has(index)) features.set(index,reference(images[index]));
      const resemblance=similarity(features.get(index),engine.templates[label]);
      const support=probabilities[index][label],none=probabilities[index][26];
      const status=resemblance>=.72 && support>=.8 && none<.1?'candidate':resemblance>=.58 && support>=.45?'uncertain':'none';
      return {letter:ALPHABET[label],status,resemblance,ranking_score:resemblance*(.5+.5*support),
        rotation:matrices[index],unit:unit.name,projection:images[index]};
    }).sort(compare);
    rows.push(proposals[0]);
  }
  return rows.sort(compare).slice(0,3);
}
async function saveImages(unit,row) {
  const canvas=new OffscreenCanvas(320,320),ctx=canvas.getContext('2d');
  const points=projected(unit,row.rotation,320,25);
  ctx.fillStyle='white';ctx.fillRect(0,0,320,320);ctx.lineWidth=5;ctx.lineCap='round';
  for (const [a,b] of unit.edges) {
    ctx.strokeStyle='hsl('+Math.round(245*(1-a/Math.max(1,points.length-1)))+' 85% 48%)';
    ctx.beginPath();ctx.moveTo(...points[a]);ctx.lineTo(...points[b]);ctx.stroke();
  }
  const square=new OffscreenCanvas(SIDE,SIDE),raw=square.getContext('2d');
  const image=raw.createImageData(SIDE,SIDE);
  row.projection.forEach((value,i)=>{
    image.data[i*4]=image.data[i*4+1]=image.data[i*4+2]=Math.round(value*255);image.data[i*4+3]=255;
  });
  raw.putImageData(image,0,0);
  const [preview,projection]=await Promise.all([canvas.convertToBlob({type:'image/webp',quality:.9}),square.convertToBlob()]);
  delete row.projection;
  return {preview,projection};
}
async function readInput(message) {
  if (typeof message.content==='string') return {text:message.content,filename:message.filename||'structure.pdb'};
  const id=message.pdbId;
  if (!/^[0-9][A-Z0-9]{3}$/.test(id)) throw new Error('Enter a four-character PDB ID.');
  const response=await fetch('https://files.rcsb.org/download/'+id+'.cif',{credentials:'omit',signal:AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error(response.status===404?'This PDB ID was not found.':'The PDB file could not be downloaded. You can upload it instead.');
  if (Number(response.headers.get('Content-Length'))>MAX_BYTES) throw new Error('This PDB file exceeds 30 MiB.');
  const reader=response.body.getReader();
  const decoder=new TextDecoder();
  let size=0,text='';
  try {
    for (;;) {
      const {value,done}=await reader.read();
      if (done) break;
      size+=value.byteLength;
      if (size>MAX_BYTES) throw new Error('This PDB file exceeds 30 MiB.');
      text+=decoder.decode(value,{stream:true});
    }
    text+=decoder.decode();
  } finally { await reader.cancel().catch(()=>{}); }
  return {text,filename:id+'.cif'};
}
if (typeof module!=='undefined' && module.exports) module.exports={makeInference,structureUnits,rotations,pixelDistances,similarity,reference};
else self.onmessage=async event=>{
  const message=event.data,id=message.id;
  const progress=value=>self.postMessage({id,type:'progress',value});
  try {
    progress('Reading structure');
    const {text,filename}=await readInput(message);
    if (text.length>MAX_BYTES) throw new Error('This file exceeds 30 MiB.');
    const units=structureUnits(text,filename);
    progress('Loading the protein model');
    const engine=await loadEngine();
    const candidates=[];
    const pdbId=message.pdbId || filename.replace(/\.[^.]*$/,'').slice(0,64) || 'Uploaded structure';
    for (let i=0;i<units.length;i++) {
      progress('Scanning protein view '+(i+1)+' of '+units.length);
      const unit=units[i];
      for (const row of searchUnit(unit,engine)) {
        if (row.status==='none') continue;
        const {preview,projection}=await saveImages(unit,row);
        candidates.push({...row,pdb_id:pdbId,preview,projection});
      }
    }
    self.postMessage({id,type:'result',candidates:candidates.sort(compare)});
  } catch (error) {
    self.postMessage({id,type:'error',message:error.name==='TimeoutError'?'The PDB download timed out. Try again or upload the structure.':error.message});
  }
};
