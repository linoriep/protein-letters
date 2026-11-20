'use strict';
const $ = id => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const STORAGE_KEY = 'protein-letters-public-molecule-studio-v1';
const ELEMENTS = new Set(['C', 'N', 'O', 'S', 'P', 'F', 'Cl', 'Br', 'I', 'H']);
const COLORS = {C:'#42513d', N:'#4b73a3', O:'#b26655', S:'#a68c38', P:'#ad8350', F:'#6e9565', Cl:'#6e9565', Br:'#a77953', I:'#89699b', H:'#89947e'};
const EXAMPLES = {
  caffeine: {smiles:'Cn1c(=O)c2c(ncn2C)n(C)c1=O', name:'CAFFEINE'},
  aspirin: {smiles:'CC(=O)Oc1ccccc1C(=O)O', name:'ASPIRIN'},
  benzene: {smiles:'c1ccccc1', name:'BENZENE'}
};
const state = {graph:{atoms:[],bonds:[]}, tool:'draw', element:'C', order:1, charge:0, selected:-1, drag:null, history:[], busy:false, authority:{type:'graph'}, canonical:'', formula:'', checked:false, smilesDirty:false, hasStereo:false};
let storageWarningShown = false;
function node(tag, text, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = String(text);
  if (className) n.className = className;
  return n;
}
function svgNode(tag, attrs = {}) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, String(value));
  return n;
}
function notice(text, error = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !text;
}
const generatedArtURLs = new Set();
function releaseArtURLs() { for (const url of generatedArtURLs) URL.revokeObjectURL(url); generatedArtURLs.clear(); }
async function api(path, body) {
  if (path === '/api/art/prepare') return window.ProteinChemistry.prepare(body);
  if (path === '/api/art/palette') {
    const response = await fetch('./letters.json');if(!response.ok) throw new Error('The letter set is unavailable.');
    const data = await response.json(), letters=[];
    for (const [letter,options] of Object.entries(data.letters || {})) {
      const selected = Array.isArray(options) ? options.find(option=>option.is_default) || options[0] : null;
      if(selected) letters.push({...selected,letter});
    }
    return {letters};
  }
  if (path === '/api/art/render') {
    const prepared = await window.ProteinChemistry.prepare(body);
    if(prepared.has_stereochemistry) throw new Error('Protein artwork cannot faithfully show stereochemistry yet. Load a molecule without explicit stereochemistry.');
    const result = await window.ProteinArtwork.render(prepared, body);
    if(result.status==='error') throw new Error(result.error || result.message || 'The artwork could not be created.');
    releaseArtURLs();
    for (const value of [result.png_url,result.svg_url]) if(typeof value==='string'&&value.startsWith('blob:')&&new URL(value).origin===location.origin) generatedArtURLs.add(value);
    return result;
  }
  throw new Error('This action is unavailable.');
}
function safeURL(value) {
  if(typeof value!=='string'||!value) return null;
  try { const url=new URL(value,location.href);return url.origin===location.origin&&(['http:','https:'].includes(url.protocol)||(url.protocol==='blob:'&&generatedArtURLs.has(value)))?url.href:null; }
  catch(_) { return null; }
}
window.addEventListener('beforeunload',releaseArtURLs);
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function cleanGraph(raw) {
  if (!raw || !Array.isArray(raw.atoms) || !Array.isArray(raw.bonds) || raw.atoms.length > 500 || raw.bonds.length > 1000) throw new Error('This sketch is too large or could not be read.');
  const atoms = raw.atoms.map(atom => {
    if (!window.ProteinChemistry.supportsElement(atom.element) || !Number.isFinite(atom.x) || !Number.isFinite(atom.y)) throw new Error('The structure contains an unsupported atom or coordinate.');
    const charge = atom.charge === undefined ? 0 : atom.charge;
    if (!Number.isInteger(charge) || charge < -8 || charge > 8) throw new Error('An atom has an unsupported charge.');
    const isotope = atom.isotope === undefined ? 0 : atom.isotope;
    if (!Number.isInteger(isotope) || isotope < 0 || isotope > 400) throw new Error('An atom has an unsupported isotope.');
    return {element:atom.element, x:atom.x, y:atom.y, charge, isotope};
  });
  const seen = new Set();
  const bonds = raw.bonds.map(bond => {
    const {a,b,order} = bond;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= atoms.length || b >= atoms.length || a === b || ![1,2,3].includes(order)) throw new Error('The structure contains an unsupported bond.');
    const key = [Math.min(a,b),Math.max(a,b)].join(':');
    if (seen.has(key)) throw new Error('The structure contains duplicate bonds.');
    seen.add(key); return {a,b,order};
  });
  return {atoms,bonds};
}
function fitGraph(graph) {
  if (!graph.atoms.length) return graph;
  const xs = graph.atoms.map(a=>a.x), ys = graph.atoms.map(a=>a.y);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  const lengths = graph.bonds.map(b=>Math.hypot(graph.atoms[b.a].x-graph.atoms[b.b].x,graph.atoms[b.a].y-graph.atoms[b.b].y)).filter(x=>x>0).sort((a,b)=>a-b);
  const scale = Math.min(lengths.length ? 57/lengths[Math.floor(lengths.length/2)] : 1, 610/Math.max(right-left,1), 310/Math.max(bottom-top,1));
  return {atoms:graph.atoms.map(a=>({...a,x:380+(a.x-(left+right)/2)*scale,y:220+(a.y-(top+bottom)/2)*scale})),bonds:graph.bonds};
}
function snapshot() {
  return {graph:copy(state.graph), authority:copy(state.authority), canonical:state.canonical, formula:state.formula, checked:state.checked, hasStereo:state.hasStereo, smiles:$('smiles-input').value, smilesDirty:state.smilesDirty};
}
function pushUndo(before = snapshot()) {
  state.history.push(before);
  if (state.history.length > 50) state.history.shift();
}
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({version:1,...snapshot(),name:$('molecule-name').value,includeName:$('include-name').checked,allowAssembled:$('allow-assembled').checked}));
  } catch (_) {
    if (!storageWarningShown) { storageWarningShown = true; notice('This browser cannot save the sketch between visits. Keep this page open and download the finished artwork.'); }
  }
}
function invalidateArt(message = 'Create the artwork to see this molecule in protein form.') {
  releaseArtURLs();
  $('art-image').hidden = true;
  $('art-image').removeAttribute('src');
  $('art-empty').hidden = false;
  $('art-downloads').hidden = true;
  $('art-caption').textContent = state.graph.atoms.length ? message : '';
  $('art-warnings').replaceChildren(); $('art-warnings').hidden = true;
}
function setBusy(value, caption) {
  state.busy = value;
  for (const el of document.querySelectorAll('main button, main input, main select, main textarea')) el.disabled = value;
  $('sketch').setAttribute('aria-busy', String(value));
  if (value && caption) notice(caption);
  refreshControls();
}
function refreshControls() {
  $('undo').disabled = state.busy || !state.history.length;
  $('clear').disabled = state.busy || !state.graph.atoms.length;
  $('check-structure').disabled = state.busy || (!state.graph.atoms.length && !$('smiles-input').value.trim());
  $('canvas-empty').hidden = state.graph.atoms.length > 0;
  if (!state.graph.atoms.length) $('structure-info').textContent = 'No molecule drawn yet';
  else if (state.hasStereo) $('structure-info').textContent = `${state.formula || 'Loaded molecule'} · Stereochemistry: editing unavailable`;
  else if (state.checked) $('structure-info').textContent = `${state.formula || 'Structure checked'}${state.formula ? ' · Structure checked' : ''}`;
  else $('structure-info').textContent = `${state.graph.atoms.length} atoms · ${state.graph.bonds.length} bonds · Not checked yet`;
  $('sketch').dataset.tool = state.tool;
}
function changed() {
  // Loaded molblocks retain all original chemical annotations until an actual
  // drawing edit. A changed sketch is thereafter sent as its actual graph.
  state.authority = {type:'graph'};
  state.canonical = ''; state.formula = ''; state.checked = false; state.hasStereo = false;
  state.smilesDirty = false; $('smiles-input').value = '';
  invalidateArt(); renderSketch(); save();
}
function stereoEditBlocked() {
  if (!state.hasStereo) return false;
  notice('This molecule includes stereochemistry, which this sketcher cannot edit. Clear the sketch or load another molecule to continue; the original structure is kept unchanged.', true);
  return true;
}
function change(mutator) {
  if (state.busy || stereoEditBlocked()) return;
  const before = snapshot();
  const didChange = mutator();
  if (didChange === false) { renderSketch(); return; }
  pushUndo(before); changed();
}
function renderSketch() {
  const bondNodes = [], atomNodes = [];
  state.graph.bonds.forEach((bond,index) => {
    const a=state.graph.atoms[bond.a],b=state.graph.atoms[bond.b];
    const group=svgNode('g',{'data-bond-index':index});
    const dx=b.x-a.x,dy=b.y-a.y,len=Math.max(Math.hypot(dx,dy),1),nx=-dy/len,ny=dx/len;
    const hit=svgNode('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,class:'bond-hit','data-bond-index':index}); group.append(hit);
    const offsets=bond.order===1?[0]:bond.order===2?[-3.4,3.4]:[-5.2,0,5.2];
    for(const offset of offsets) group.append(svgNode('line',{x1:a.x+nx*offset,y1:a.y+ny*offset,x2:b.x+nx*offset,y2:b.y+ny*offset,class:'bond-visible'}));
    bondNodes.push(group);
  });
  state.graph.atoms.forEach((atom,index) => {
    const group=svgNode('g',{transform:`translate(${atom.x} ${atom.y})`,'data-atom-index':index,class:'atom-group'+(state.selected===index?' selected':''),tabindex:'0',role:'button','aria-label':`${atom.element} atom ${index+1}${atom.charge?', charge '+atom.charge:''}`});
    group.append(svgNode('circle',{r:atom.element.length>1?16:13,class:'atom-background'}));
    const text=svgNode('text',{fill:COLORS[atom.element]||COLORS.C});text.textContent=atom.element;group.append(text);
    if(atom.isotope){const isotope=svgNode('text',{x:-15,y:-15,class:'atom-isotope',fill:COLORS[atom.element]||COLORS.C});isotope.textContent=String(atom.isotope);group.append(isotope);}
    if(atom.charge){const charge=svgNode('text',{x:atom.element.length>1?13:10,y:-12,class:'atom-charge',fill:COLORS[atom.element]||COLORS.C});charge.textContent=Math.abs(atom.charge)===1?(atom.charge>0?'+':'−'):Math.abs(atom.charge)+(atom.charge>0?'+':'−');group.append(charge);}
    atomNodes.push(group);
  });
  $('bonds').replaceChildren(...bondNodes); $('atoms').replaceChildren(...atomNodes); refreshControls();
}
function point(event) {
  const matrix=$('sketch').getScreenCTM();
  if(!matrix) return {x:380,y:220};
  const p=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
  return {x:Math.max(25,Math.min(735,p.x)),y:Math.max(25,Math.min(415,p.y))};
}
function nearestAtom(p,exclude=-1) {
  let index=-1,distance=21;
  state.graph.atoms.forEach((atom,i)=>{const d=Math.hypot(p.x-atom.x,p.y-atom.y);if(i!==exclude&&d<distance){index=i;distance=d;}});
  return index;
}
function targetIndex(target,attribute) {
  const group=target.closest('['+attribute+']');
  return group?Number(group.getAttribute(attribute)):-1;
}
function endpoint(start,end,free=false) {
  const angle=Math.atan2(end.y-start.y,end.x-start.x);
  const snapped=free?angle:Math.round(angle/(Math.PI/6))*(Math.PI/6);
  const length=free?Math.min(120,Math.max(35,Math.hypot(end.x-start.x,end.y-start.y))):57;
  return {x:Math.max(25,Math.min(735,start.x+Math.cos(snapped)*length)),y:Math.max(25,Math.min(415,start.y+Math.sin(snapped)*length))};
}
function addAtom(p) {
  if(state.graph.atoms.length>=500) throw new Error('This sketch has reached the 500-atom limit.');
  state.graph.atoms.push({element:state.element,x:p.x,y:p.y,charge:state.charge});
  return state.graph.atoms.length-1;
}
function addBond(a,b) {
  if(a===b)return false;
  const existing=state.graph.bonds.find(bond=>(bond.a===a&&bond.b===b)||(bond.a===b&&bond.b===a));
  if(existing){if(existing.order===state.order)return false;existing.order=state.order;}
  else state.graph.bonds.push({a,b,order:state.order});
  return true;
}
function removeAtom(index) {
  state.graph.atoms.splice(index,1);
  state.graph.bonds=state.graph.bonds.filter(b=>b.a!==index&&b.b!==index).map(b=>({...b,a:b.a>index?b.a-1:b.a,b:b.b>index?b.b-1:b.b}));
  state.selected=-1;
}
function stampRing(center,anchor=-1) {
  if(state.graph.atoms.length+6>500)throw new Error('There is not enough room for another ring in this sketch.');
  if(anchor>=0&&state.graph.atoms[anchor].element!=='C')throw new Error('Place the benzene ring on empty space or on a carbon atom.');
  const indices=[],radius=57;
  // Clicking an existing atom fuses the new ring at that atom; a blank click
  // places a complete six-carbon ring without joining an unrelated fragment.
  const origin=anchor>=0?{x:state.graph.atoms[anchor].x+radius,y:state.graph.atoms[anchor].y}:{x:Math.max(85,Math.min(675,center.x)),y:Math.max(85,Math.min(355,center.y))};
  for(let i=0;i<6;i++){
    if(i===3&&anchor>=0){indices.push(anchor);continue;}
    const angle=i*Math.PI/3;
    state.graph.atoms.push({element:'C',x:origin.x+Math.cos(angle)*radius,y:origin.y+Math.sin(angle)*radius,charge:0});indices.push(state.graph.atoms.length-1);
  }
  for(let i=0;i<6;i++)state.graph.bonds.push({a:indices[i],b:indices[(i+1)%6],order:i%2===0?2:1});
  state.selected=indices[0];
}
$('sketch').addEventListener('pointerdown',event=>{
  if(state.busy||event.button!==0||stereoEditBlocked())return;
  event.preventDefault();$('sketch').focus();
  const p=point(event),atom=targetIndex(event.target,'data-atom-index'),bond=targetIndex(event.target,'data-bond-index');
  if(state.tool==='erase'){change(()=>{if(atom>=0)removeAtom(atom);else if(bond>=0)state.graph.bonds.splice(bond,1);else return false;});return;}
  if(state.tool==='ring'){try{change(()=>stampRing(p,atom));}catch(error){notice(error.message,true);}return;}
  state.selected=atom;
  $('atom-charge').value=String(atom>=0?state.graph.atoms[atom].charge||0:state.charge);
  state.drag={start:p,last:p,atom,bond,before:snapshot(),pointer:event.pointerId};
  $('sketch').setPointerCapture(event.pointerId);renderSketch();
});
$('sketch').addEventListener('pointermove',event=>{
  const drag=state.drag;if(!drag||drag.pointer!==event.pointerId)return;
  const p=point(event);drag.last=p;
  if(state.tool==='move'&&drag.atom>=0){state.graph.atoms[drag.atom].x=p.x;state.graph.atoms[drag.atom].y=p.y;renderSketch();return;}
  if(state.tool==='draw'&&Math.hypot(p.x-drag.start.x,p.y-drag.start.y)>8){
    const start=drag.atom>=0?state.graph.atoms[drag.atom]:drag.start;
    const target=nearestAtom(p,drag.atom),end=target>=0?state.graph.atoms[target]:endpoint(start,p,event.shiftKey);
    $('ghost').replaceChildren(svgNode('line',{x1:start.x,y1:start.y,x2:end.x,y2:end.y,class:'ghost-line'}));
  }
});
function endPointer(event,cancelled=false){
  const drag=state.drag;if(!drag||drag.pointer!==event.pointerId)return;
  state.drag=null;$('ghost').replaceChildren();
  if($('sketch').hasPointerCapture(event.pointerId))$('sketch').releasePointerCapture(event.pointerId);
  if(cancelled){state.graph=drag.before.graph;renderSketch();return;}
  const p=point(event),distance=Math.hypot(p.x-drag.start.x,p.y-drag.start.y);
  try{
    if(state.tool==='move'){
      if(drag.atom>=0&&distance>1){pushUndo(drag.before);changed();}else renderSketch();return;
    }
    let mutated=false;
    if(drag.bond>=0&&distance<8){const b=state.graph.bonds[drag.bond];if(b.order!==state.order){b.order=state.order;mutated=true;}}
    else if(distance>8){
      const start=drag.atom>=0?state.graph.atoms[drag.atom]:drag.start;
      let target=nearestAtom(p,drag.atom),end=target>=0?state.graph.atoms[target]:endpoint(start,p,event.shiftKey);
      const a=drag.atom>=0?drag.atom:addAtom(start);
      if(target<0)target=addAtom(end);
      mutated=addBond(a,target);state.selected=target;
    }else if(drag.atom>=0){const atom=state.graph.atoms[drag.atom];if(atom.element!==state.element||atom.charge!==state.charge){atom.element=state.element;atom.charge=state.charge;mutated=true;}}
    else{state.selected=addAtom(p);mutated=true;}
    if(mutated){pushUndo(drag.before);changed();}else renderSketch();
  }catch(error){state.graph=drag.before.graph;renderSketch();notice(error.message,true);}
}
$('sketch').addEventListener('pointerup',event=>endPointer(event));
$('sketch').addEventListener('pointercancel',event=>endPointer(event,true));
$('sketch').addEventListener('keydown',event=>{
  if(state.busy)return;
  const index=targetIndex(event.target,'data-atom-index');if(index>=0)state.selected=index;
  if(event.key==='Escape'){if(state.drag)state.graph=state.drag.before.graph;state.selected=-1;state.drag=null;$('ghost').replaceChildren();renderSketch();return;}
  if((event.key==='Delete'||event.key==='Backspace')&&state.selected>=0){event.preventDefault();change(()=>removeAtom(state.selected));$('sketch').focus();return;}
  const moves={ArrowLeft:[-8,0],ArrowRight:[8,0],ArrowUp:[0,-8],ArrowDown:[0,8]};
  if(moves[event.key]&&state.selected>=0){event.preventDefault();const selected=state.selected;change(()=>{const atom=state.graph.atoms[selected];atom.x=Math.max(25,Math.min(735,atom.x+moves[event.key][0]));atom.y=Math.max(25,Math.min(415,atom.y+moves[event.key][1]));});$('atoms').children[selected]?.focus();}
  if((event.key==='Enter'||event.key===' ')&&index>=0){event.preventDefault();if(state.tool==='erase')change(()=>removeAtom(index));else change(()=>{const atom=state.graph.atoms[index];if(atom.element===state.element&&atom.charge===state.charge)return false;atom.element=state.element;atom.charge=state.charge;});}
});
for(const button of document.querySelectorAll('[data-tool]'))button.addEventListener('click',()=>{
  state.tool=button.dataset.tool;
  for(const b of document.querySelectorAll('[data-tool]')){const active=b===button;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}
  refreshControls();
});
for(const button of document.querySelectorAll('[data-element]'))button.addEventListener('click',()=>{
  state.element=button.dataset.element;
  for(const b of document.querySelectorAll('[data-element]')){const active=b===button;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}
  if(state.selected>=0)change(()=>{const atom=state.graph.atoms[state.selected];if(atom.element===state.element)return false;atom.element=state.element;});
});
for(const button of document.querySelectorAll('[data-bond]'))button.addEventListener('click',()=>{
  state.order=Number(button.dataset.bond);
  for(const b of document.querySelectorAll('[data-bond]')){const active=b===button;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}
  document.querySelector('[data-tool="draw"]').click();
});
$('atom-charge').addEventListener('change',()=>{
  state.charge=Number($('atom-charge').value);
  if(state.selected>=0)change(()=>{const atom=state.graph.atoms[state.selected];if(atom.charge===state.charge)return false;atom.charge=state.charge;});
});
function undo(){
  if(state.busy||!state.history.length)return;
  const previous=state.history.pop();
  state.graph=previous.graph;state.hasStereo=Boolean(previous.hasStereo);state.authority=previous.authority;state.canonical=previous.canonical;state.formula=previous.formula;state.checked=previous.checked;state.smilesDirty=previous.smilesDirty;$('smiles-input').value=previous.smiles;
  state.selected=-1;invalidateArt();renderSketch();save();
}
$('undo').addEventListener('click',undo);
$('clear').addEventListener('click',()=>{
  if(state.busy)return;
  pushUndo();state.graph={atoms:[],bonds:[]};state.selected=-1;state.hasStereo=false;changed();
});
document.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'&&!event.shiftKey&&!['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)){event.preventDefault();undo();}
});
function applyPrepared(result,sourceKind){
  if(typeof result.molblock!=='string'||!result.molblock.trim()||typeof result.canonical_smiles!=='string'||!result.canonical_smiles.trim())throw new Error('The structure could not be prepared.');
  const graph=fitGraph(cleanGraph(result.graph));if(!graph.atoms.length)throw new Error('The molecule has no atoms.');
  pushUndo();state.graph=graph;state.selected=-1;state.canonical=result.canonical_smiles;state.formula=String(result.formula||'');state.checked=true;state.smilesDirty=false;state.hasStereo=result.has_stereochemistry===true;
  state.authority={type:'molblock',value:result.molblock};
  $('smiles-input').value=result.canonical_smiles;
  invalidateArt();renderSketch();save();
}
async function prepareSmiles(text){
  const smiles=text.trim();if(!smiles)throw new Error('Paste a SMILES string first.');if(new Blob([smiles]).size>1024*1024)throw new Error('Use a SMILES string smaller than 1 MiB.');
  const result=await api('/api/art/prepare',{smiles});applyPrepared(result,'smiles');return result;
}
async function loadSmiles(text,name){
  if(state.busy)return;
  setBusy(true,'Loading the molecule…');
  try{await prepareSmiles(text);if(name)$('molecule-name').value=name;save();notice(state.hasStereo?'This molecule includes stereochemistry. Its original structure is retained, but this sketcher cannot edit it. Clear it or load another molecule to continue.':'Molecule loaded. Add a name or create the artwork.');}
  catch(error){notice(error.message,true);}
  finally{setBusy(false);}
}
$('smiles-form').addEventListener('submit',event=>{event.preventDefault();loadSmiles($('smiles-input').value);});
$('smiles-input').addEventListener('input',()=>{state.smilesDirty=true;invalidateArt('Load this SMILES string, or create the artwork to use it.');refreshControls();save();});
$('smiles-file').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;
  try{if(file.size>1024*1024)throw new Error('Choose a SMILES file smaller than 1 MiB.');const text=await file.text();const line=text.split(/\r?\n/).map(s=>s.trim()).find(s=>s&&!s.startsWith('#'));if(!line)throw new Error('The file has no SMILES string.');const parts=line.split(/\s+/);$('smiles-input').value=parts[0];state.smilesDirty=true;await loadSmiles(parts[0],parts.slice(1).join(' ').slice(0,80));}
  catch(error){notice(error.message,true);}finally{event.target.value='';}
});
for(const button of document.querySelectorAll('[data-example]'))button.addEventListener('click',()=>{const example=EXAMPLES[button.dataset.example];loadSmiles(example.smiles,example.name);});
$('check-structure').addEventListener('click',async()=>{
  if(state.busy)return;
  setBusy(true,'Checking the structure…');
  try{
    if(state.smilesDirty&&$('smiles-input').value.trim())await prepareSmiles($('smiles-input').value);
    else if(state.authority.type==='molblock'&&state.checked)notice('This loaded structure is ready for artwork.');
    else{if(!state.graph.atoms.length)throw new Error('Draw a molecule first.');applyPrepared(await api('/api/art/prepare',{graph:state.graph}),'graph');}
    notice(state.hasStereo?'This molecule includes stereochemistry. Its original structure is kept unchanged; editing and artwork are not supported yet.':`Structure checked${state.formula?' · '+state.formula:''}. Ready to create the artwork.`);
  }catch(error){notice(error.message,true);}finally{setBusy(false);}
});
function renderSource(){
  if(state.authority.type==='molblock'&&typeof state.authority.value==='string')return {molblock:state.authority.value};
  return {graph:state.graph};
}
$('art-form').addEventListener('submit',async event=>{
  event.preventDefault();if(state.busy)return;
  setBusy(true,'Creating the protein artwork…');
  try{
    if(state.smilesDirty){if(!$('smiles-input').value.trim())throw new Error('Paste a SMILES string or continue drawing a molecule.');await prepareSmiles($('smiles-input').value);}
    if(!state.graph.atoms.length)throw new Error('Draw a molecule or load a SMILES string first.');
    if(state.hasStereo)throw new Error('Artwork with stereochemistry is not supported yet. Clear this sketch or load a molecule without stereochemistry.');
    // Drawings are validated before rendering. Imported structures keep their
    // unchanged molblock, preserving annotations absent from the simple graph.
    if(state.authority.type==='graph'&&!state.checked)applyPrepared(await api('/api/art/prepare',{graph:state.graph}),'graph');
    const name=$('molecule-name').value.trim();
    const result=await api('/api/art/render',{...renderSource(),name,include_name:$('include-name').checked&&Boolean(name),allow_assembled:$('allow-assembled').checked});
    if(result.status==='missing_glyphs'){
      const missing=Array.isArray(result.missing_letters)?[...new Set(result.missing_letters.map(String))]:[];
      invalidateArt('No artwork created. Some letters in the name are unavailable.');
      const warnings=Array.isArray(result.warnings)?result.warnings.map(String):[];
      if(missing.length)warnings.unshift('Name letters unavailable: '+missing.join(', ')+'.');
      if(!$('allow-assembled').checked)warnings.push('Enable assembled name letters, change the name, or leave the name out.');
      $('art-warnings').replaceChildren(...warnings.map(text=>node('li',text)));$('art-warnings').hidden=!warnings.length;
      notice('Some letters in the name are unavailable'+(missing.length?': '+missing.join(', '):'.')+' No artwork was created.',true);
      return;
    }
    const png=safeURL(result.png_url),svg=safeURL(result.svg_url);
    if(!png||!svg)throw new Error('The artwork could not be downloaded. Please try again.');
    $('art-image').src=png;$('art-image').alt=`Protein artwork of ${name||state.formula||'the molecule'}`;$('art-image').hidden=false;$('art-empty').hidden=true;
    $('download-png').href=png;$('download-svg').href=svg;$('art-downloads').hidden=false;
    const missing=Array.isArray(result.missing_letters)?result.missing_letters.map(String):[];
    const warnings=Array.isArray(result.warnings)?result.warnings.map(String):[];
    if(missing.length)warnings.unshift('Letters unavailable for the name: '+[...new Set(missing)].join(', ')+'.');
    $('art-warnings').replaceChildren(...warnings.map(text=>node('li',text)));$('art-warnings').hidden=!warnings.length;
    $('art-caption').textContent=missing.length?'Artwork created; the name has missing letters.':'Artwork ready. Download it as PNG or SVG.';
    notice(missing.length?'The artwork is ready with gaps in the name. See the missing letters below.':'Protein artwork created.');save();
  }catch(error){notice(error.message,true);}finally{setBusy(false);}
});
$('art-image').addEventListener('error',()=>{if(!$('art-image').hasAttribute('src'))return;$('art-image').hidden=true;$('art-empty').hidden=false;notice('The artwork preview could not be loaded. Use a download link if available, or try creating it again.',true);});
for(const id of ['molecule-name','include-name','allow-assembled'])$(id).addEventListener(id==='molecule-name'?'input':'change',()=>{invalidateArt('The artwork options changed. Create it again to apply them.');save();});
async function loadPalette(){
  try{
    const result=await api('/api/art/palette');if(!Array.isArray(result.letters))throw new Error('The letter set is unavailable.');
    const cards=result.letters.filter(row=>row&&typeof row.letter==='string'&&/^[A-Z]$/.test(row.letter)&&['protein','assembled'].includes(row.kind)).map(row=>{
      const card=node('div',undefined,'palette-glyph'),url=safeURL(row.image_url);
      if(url){const image=node('img');image.src=url;image.loading='lazy';image.alt=`${row.letter}, ${row.kind==='assembled'?'assembled letter':row.pdb_id||'protein view'}`;card.append(image);}
      card.append(node('strong',row.letter),node('small',row.kind==='assembled'?'Assembled':row.pdb_id||'Protein'));return card;
    });
    $('palette').replaceChildren(...cards);if(!cards.length)$('palette').append(node('span','No letter views are available yet.','field-help'));
    $('palette-policy').textContent='The standard set is used by default. Enable the option above to build other missing name letters from protein pieces.';
  }catch(error){$('palette').replaceChildren(node('span','The letter set could not be loaded.','field-help'));$('palette-policy').textContent=error.message;}
}
function restore(){
  try{
    const raw=localStorage.getItem(STORAGE_KEY);if(!raw)return;
    const saved=JSON.parse(raw);if(saved.version!==1)return;
    state.graph=cleanGraph(saved.graph);
    state.authority=saved.authority?.type==='molblock'&&typeof saved.authority.value==='string'&&saved.authority.value.length<1024*1024?{type:'molblock',value:saved.authority.value}:{type:'graph'};
    state.canonical=typeof saved.canonical==='string'?saved.canonical:'';state.formula=typeof saved.formula==='string'?saved.formula:'';state.checked=Boolean(saved.checked);state.smilesDirty=Boolean(saved.smilesDirty);state.hasStereo=Boolean(saved.hasStereo)||(saved.hasStereo===undefined&&/[@/\\]/.test(state.canonical));
    $('smiles-input').value=typeof saved.smiles==='string'?saved.smiles:'';$('molecule-name').value=typeof saved.name==='string'?saved.name.slice(0,80):'';$('include-name').checked=saved.includeName!==false;$('allow-assembled').checked=saved.allowAssembled===true;
    if(state.graph.atoms.length)notice(state.hasStereo?'The last molecule has been restored with its original stereochemistry. Editing is unavailable; clear it or load another molecule to continue.':'The last sketch has been restored.');
  }catch(_){notice('The saved sketch could not be restored. Start a new sketch or load a molecule.');}
}
restore();renderSketch();loadPalette();
