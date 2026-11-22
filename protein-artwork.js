/* Local browser chemical artwork. Geometry follows src/protein_art.py.
 * Every bond stroke is one complete saved protein rod, uniformly scaled and
 * rigidly rotated. Source PNGs are only made transparent and tightly cropped.
 */
(() => {
  'use strict';
  const base = new URL('./', document.baseURI), cache = new Map();
  const color = '#244d44', font = 'Arial, sans-serif';
  const plus = (a,b) => [a[0]+b[0],a[1]+b[1]];
  const mul = (a,n) => [a[0]*n,a[1]*n];
  const sub = (a,b) => plus(a,mul(b,-1));
  const norm = a => Math.hypot(...a);
  const dot = (a,b) => a[0]*b[0]+a[1]*b[1];
  const esc = s => String(s).replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  function fail(code,message) { const e = new Error(message); e.code=code; throw e; }
  function localURL(path) {
    const url = new URL(path,base);
    if(url.origin!==base.origin || !url.pathname.startsWith(base.pathname) || !/^https?:$/.test(url.protocol)) fail('invalid_asset','Artwork assets must belong to this site.');
    return url.href;
  }
  async function json() {
    if(!cache.has('letters')) cache.set('letters',fetch(localURL('letters.json')).then(async r=>{if(!r.ok) fail('missing_palette','Protein letters could not be loaded.'); return r.json();}));
    return cache.get('letters');
  }
  async function asset(path) {
    const url=localURL(path);
    if(!cache.has(url)) cache.set(url,(async()=>{
      const r=await fetch(url); if(!r.ok) fail('missing_asset','A protein image could not be loaded.');
      const bitmap=await createImageBitmap(await r.blob());
      if(bitmap.width>4096 || bitmap.height>4096) { bitmap.close(); fail('invalid_asset','Protein image is too large.'); }
      const c=document.createElement('canvas'); c.width=bitmap.width;c.height=bitmap.height;
      const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);bitmap.close();
      const data=ctx.getImageData(0,0,c.width,c.height);let left=c.width,top=c.height,right=-1,bottom=-1;
      for(let y=0;y<c.height;y++) for(let x=0;x<c.width;x++) {
        const i=(y*c.width+x)*4;
        if(Math.min(data.data[i],data.data[i+1],data.data[i+2])>=250) data.data[i+3]=0;
        if(data.data[i+3]) {left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
      }
      if(right<left) fail('empty_asset','A protein image has no visible pixels.');
      ctx.putImageData(data,0,0); const crop=document.createElement('canvas');crop.width=right-left+1;crop.height=bottom-top+1;
      crop.getContext('2d').drawImage(c,left,top,crop.width,crop.height,0,0,crop.width,crop.height);
      return {width:crop.width,height:crop.height,data:crop.toDataURL('image/png')};
    })().catch(e=>{cache.delete(url);throw e;}));
    return cache.get(url);
  }
  function graph(prepared) {
    if(!prepared || prepared.status==='error' || !prepared.graph) fail('invalid_preparation','Prepare a molecule before creating its artwork.');
    if(prepared.has_stereochemistry || prepared.has_radicals || prepared.radical_electrons>0) fail(prepared.has_stereochemistry?'unsupported_stereochemistry':'unsupported_radical',prepared.has_stereochemistry?'Protein artwork cannot faithfully show stereochemistry.':'Radical-electron artwork is not supported.');
    const g=prepared.graph;
    if(!Array.isArray(g.atoms)||!Array.isArray(g.bonds)||g.atoms.length<1||g.atoms.length>240||g.bonds.length>240) fail('invalid_graph','The prepared molecule has invalid size or connectivity.');
    const atoms=g.atoms.map(a=>{
      if(!a||!/^[A-Z][a-z]?$/.test(a.element)||![a.x,a.y].every(v=>Number.isFinite(v)&&Math.abs(v)<=1e6)) fail('invalid_graph','Atom elements and coordinates are invalid.');
      if(a.stereo || a.chiral_tag && !['CHI_UNSPECIFIED',0].includes(a.chiral_tag)) fail('unsupported_stereochemistry','Protein artwork cannot faithfully show stereochemistry.');
      if(a.radical_electrons>0||a.radicals>0||a.num_radical_electrons>0) fail('unsupported_radical','Radical-electron artwork is not supported.');
      const atom={...a,charge:a.charge??0,isotope:a.isotope??0,total_h:a.total_h??0};
      if(!Number.isInteger(atom.charge)||Math.abs(atom.charge)>8||!Number.isInteger(atom.isotope)||atom.isotope<0||atom.isotope>999||!Number.isInteger(atom.total_h)||atom.total_h<0||atom.total_h>8) fail('invalid_graph','Atom annotations are invalid.');
      return atom;
    });
    const seen=new Set(),adj=atoms.map(()=>[]);
    const bonds=g.bonds.map((b,i)=>{
      if(!b||!Number.isInteger(b.a)||!Number.isInteger(b.b)||b.a<0||b.b<0||b.a>=atoms.length||b.b>=atoms.length||b.a===b.b||![1,2,3].includes(b.order)) fail('invalid_graph','Bond endpoints or orders are invalid.');
      if(b.stereo && !['STEREONONE',0].includes(b.stereo)) fail('unsupported_stereochemistry','Protein artwork cannot faithfully show stereochemistry.');
      const key=[b.a,b.b].sort((a,b)=>a-b).join('-');if(seen.has(key))fail('invalid_graph','Duplicate chemical bond.');seen.add(key);adj[b.a].push([b.b,i]);adj[b.b].push([b.a,i]);
      if(norm([atoms[b.a].x-atoms[b.b].x,atoms[b.a].y-atoms[b.b].y])<1e-5) fail('invalid_coordinates','Bond endpoints cannot occupy the same position.');
      return {...b};
    });
    // Smallest cycle through each bond gives the inward direction, including
    // adapters which do not expose RDKit AtomRings. Prefer provided rings.
    const rings=(g.rings||prepared.rings||[]).filter(r=>Array.isArray(r)&&r.length>=3&&new Set(r).size===r.length&&r.every(a=>Number.isInteger(a)&&a>=0&&a<atoms.length)&&r.every((a,i)=>adj[a].some(([z])=>z===r[(i+1)%r.length])));
    const bondRings=bonds.map((b,i)=>{
      const supplied=rings.filter(r=>r.includes(b.a)&&r.includes(b.b)&&r.some((a,j)=>a===b.a&&[r[(j+1)%r.length],r[(j+r.length-1)%r.length]].includes(b.b))).sort((a,b)=>a.length-b.length);
      if(supplied.length)return supplied[0];
      const queue=[[b.a]],visited=new Set([b.a]);
      for(let q=0;q<queue.length;q++)for(const [z,bi] of adj[queue[q].at(-1)]) {
        if(bi===i||visited.has(z))continue; const path=[...queue[q],z];if(z===b.b)return path;visited.add(z);queue.push(path);
      }
      return null;
    });
    const aromatic = new Set(g.aromaticBonds);
    let tilt = null;
    for (const ring of rings) {
      if (ring.length !== 6 || ring.some(i => atoms[i].element !== 'C')) continue;
      if (!ring.every((a, i) => adj[a].some(([b, bond]) => b === ring[(i + 1) % ring.length] && aromatic.has(bond)))) continue;
      ring.forEach((a, i) => {
        const b = ring[(i + 1) % ring.length];
        const angle = Math.atan2(atoms[b].y - atoms[a].y, atoms[b].x - atoms[a].x);
        const offset = (angle + 1.5 * Math.PI) % Math.PI - Math.PI / 2;
        if (tilt === null || Math.abs(offset) < Math.abs(tilt)) tilt = offset;
      });
    }
    return {atoms,bonds,adj,bondRings,tilt:tilt ?? 0};
  }
  class SVGCanvas {
    constructor(width,height,rod,nameColor) {
      this.width=width;this.height=height;this.rodAsset=rod;this.nameColor=nameColor;
      this.parts=[`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/>`];
      if (nameColor) {
        const channels = nameColor.slice(1).match(/../g).map(hex => parseInt(hex, 16) / 255);
        const matrix = channels.flatMap(channel => [0.299, 0.587, 0.114]
          .map(weight => weight * (1 - channel)).concat(0, channel));
        this.parts.push(`<defs><filter id="name-color" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${[...matrix, 0, 0, 0, 1, 0].join(' ')}"/></filter></defs>`);
      }
      this.placements=[];this.measure=document.createElement('canvas').getContext('2d');
    }
    stamp(key,asset,x,y,height,angle,role) {
      const width=height*asset.width/asset.height;
      const filter = this.nameColor && role.startsWith('name ') ? ' filter="url(#name-color)"' : '';
      this.parts.push(`<image href="${asset.data}" x="${-width/2}" y="${-height/2}" width="${width}" height="${height}" transform="translate(${x} ${y}) rotate(${angle})"${filter}/>`);
      this.placements.push({kind:'protein',asset:key,center:[x,y],height,width,angle,uniform_scale:height/asset.height,role});
    }
    rod(a,b,role) {const d=sub(b,a),length=norm(d);if(length<1)return;const [x,y]=mul(plus(a,b),.5);this.stamp('rod',this.rodAsset,x,y,length,Math.atan2(d[1],d[0])*180/Math.PI-90,role);}
    glyph(letter,item,x,y,height,role) {this.stamp(letter,item.asset,x,y,height,0,role);}
    textWidth(text,size,heavy=false) {this.measure.font=`${heavy?'bold ':''}${Math.max(10,Math.round(size))}px ${font}`;return this.measure.measureText(String(text)).width;}
    text(text,x,y,size,role,heavy=false) {size=Math.max(10,Math.round(size));this.parts.push(`<text x="${x}" y="${y}" fill="${color}" font-family="${font}" font-size="${size}" font-weight="${heavy?700:400}" text-anchor="middle" dominant-baseline="central">${esc(text)}</text>`);this.placements.push({kind:'text',text:String(text),center:[x,y],size,heavy,role});}
    svg() {return this.parts.join('\n')+'</svg>';}
  }
  async function render(prepared,body={}) {
    let svgURL;
    try {
      const {atoms,bonds,adj,bondRings,tilt}=graph(prepared);
      if(!body||typeof body!=='object'||Array.isArray(body))fail('invalid_request','Artwork options are invalid.');
      for(const k of ['include_name','allow_assembled'])if(k in body&&typeof body[k]!=='boolean')fail('invalid_request','Artwork options must be true or false.');
      const nameColor=body.name_color;
      if (nameColor != null && (typeof nameColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(nameColor))) {
        fail('invalid_name_color','Choose a valid letter color.');
      }
      const name=body.include_name?String(body.name||'').trim().toUpperCase():'';
      if(name.length>120||/[^A-Z -]/.test(name))fail('unsupported_name_characters','Protein names may contain A–Z letters, spaces, and hyphens.');
      const catalog=await json(), glyphs=new Map(), missing=new Set(),conventional=new Set();
      async function glyph(letter,role) {
        const entries=catalog.letters?.[letter];const option=Array.isArray(entries)?entries.find(o=>o.is_default)||entries[0]:null;
        if(!option || role==='name'&&option.kind==='assembled'&&!body.allow_assembled) {missing.add(letter);return;}
        if(!glyphs.has(letter))glyphs.set(letter,{asset:await asset(option.image_url),kind:option.kind});
      }
      const explicit=(a,i)=>a.element!=='C'||a.charge||a.isotope||!adj[i].length;
      for(let i=0;i<atoms.length;i++)if(explicit(atoms[i],i)) {const a=atoms[i];if(a.element.length===1)await glyph(a.element,'atom');else conventional.add(a.element);if(a.total_h)await glyph('H','atom');}
      for(const letter of new Set(name.replace(/[ -]/g,'')))await glyph(letter,'name');
      if(missing.size)return {status:'missing_glyphs',missing_letters:[...missing].sort(),warnings:['No artwork was generated. Enable assembled letters for missing name glyphs.']};
      const rod=await asset('assets/rod.png'); if(rod.width>rod.height)fail('invalid_rod','The protein bond rod must be vertical.');
      const cosine=Math.cos(tilt),sine=Math.sin(tilt);
      const coords=atoms.map(({x,y})=>[cosine*x+sine*y,-sine*x+cosine*y]);
      const xs=coords.map(p=>p[0]),ys=coords.map(p=>p[1]);
      const center=[(Math.min(...xs)+Math.max(...xs))/2,(Math.min(...ys)+Math.max(...ys))/2];
      const lengths=bonds.map(b=>norm(sub(coords[b.a],coords[b.b]))).sort((a,b)=>a-b);
      const median=lengths.length?(lengths[Math.floor((lengths.length-1)/2)]+lengths[Math.floor(lengths.length/2)])/2:0;
      const factor=median?170/median:100;
      const ext=[(Math.max(...xs)-Math.min(...xs))*factor,(Math.max(...ys)-Math.min(...ys))*factor];
      const scale=Math.min(1,2100/Math.max(1,ext[0]),1700/Math.max(1,ext[1]));
      for(let i=0;i<coords.length;i++)coords[i]=mul(sub(coords[i],center),factor*scale);
      const h=76*scale,padX=140*scale+35,padY=55*scale+25;
      const moleculeW=Math.max(400,ext[0]*scale+2*padX),moleculeH=Math.max(250,ext[1]*scale+2*padY);
      const nameH=name?94*Math.min(1,scale+.2):0,lineH=nameH+20;
      let lines=[],line=[],lineWidth=0;
      for(const ch of name) {
        const w=nameH*(ch===' '?.4:ch==='-'?.5:glyphs.get(ch).asset.width/glyphs.get(ch).asset.height),token=w+nameH*.18;
        if(line.length&&lineWidth+token>2200) {lines.push([line,lineWidth]);line=[];lineWidth=0;}
        line.push([ch,w]);lineWidth+=token;
      }
      if(line.length)lines.push([line,lineWidth]);
      const width=Math.ceil(Math.max(moleculeW,...lines.map(l=>l[1]+70))),top=30+lines.length*lineH,height=Math.ceil(top+moleculeH+30);
      if(width>3000||height>3000)fail('layout_too_large','This molecule/name layout exceeds the artwork size limit.');
      const canvas=new SVGCanvas(width,height,rod,nameColor);
      for(let i=0;i<coords.length;i++)coords[i]=plus(coords[i],[width/2,top+moleculeH/2]);
      for(let bi=0;bi<bonds.length;bi++) {
        const b=bonds[bi],a=coords[b.a],z=coords[b.b],d=sub(z,a),length=norm(d),u=mul(d,1/length),n=[-u[1],u[0]];
        let start=explicit(atoms[b.a],b.a)?plus(a,mul(u,Math.min(h*.65,length*.28))):a;
        let end=explicit(atoms[b.b],b.b)?plus(z,mul(u,-Math.min(h*.65,length*.28))):z;
        let strokes;
        const ring=bondRings[bi];
        if(b.order===2&&ring) {
          const rc=mul(ring.reduce((s,i)=>plus(s,coords[i]),[0,0]),1/ring.length),middle=mul(plus(a,z),.5);
          const inward=mul(n,dot(n,sub(rc,middle))>=0?1:-1),inset=18*scale,trim=Math.min(inset*Math.tan(Math.PI/ring.length),norm(sub(end,start))*.18);
          strokes=[[start,end],[plus(plus(start,mul(inward,inset)),mul(u,trim)),plus(plus(end,mul(inward,inset)),mul(u,-trim))]];
        } else strokes=({1:[0],2:[-12*scale,12*scale],3:[-21*scale,0,21*scale]})[b.order].map(offset=>[plus(start,mul(n,offset)),plus(end,mul(n,offset))]);
        strokes.forEach(([p,q],i)=>canvas.rod(p,q,`bond ${bi} order ${b.order} stroke ${i}`));
      }
      for(let i=0;i<atoms.length;i++) {
        const a=atoms[i];if(!explicit(a,i))continue;const [x,y]=coords[i];
        if(a.element.length>1)canvas.text(a.element,x,y,h*.7,`atom ${i} conventional element`);
        else canvas.glyph(a.element,glyphs.get(a.element),x,y,h,`atom ${i} ${a.element}`);
        let labelRight=x+(a.element.length>1?canvas.textWidth(a.element,h*.7):h*glyphs.get(a.element).asset.width/glyphs.get(a.element).asset.height)/2;
        if(a.total_h) {
          const neighbors=adj[i].map(([j])=>sub(coords[j],coords[i])).map(v=>mul(v,1/norm(v)));
          const directions=[[1,0],[-1,0],[0,-1],[0,1]];
          const score=d=>neighbors.length?Math.max(...neighbors.map(n=>dot(d,n))):-1;
          const hd=directions.reduce((best,d)=>score(d)<score(best)?d:best),[hx,hy]=plus([x,y],mul(hd,h*.86)),hg=glyphs.get('H');
          canvas.glyph('H',hg,hx,hy,h*.85,`atom ${i} attached H`);
          if(a.total_h>1)canvas.text(a.total_h,hx+h*.4,hy+h*.35,h*.35,`atom ${i} H count`);
          if(hd[0]>.5) {labelRight=Math.max(labelRight,hx+h*.85*hg.asset.width/hg.asset.height/2);if(a.total_h>1)labelRight=Math.max(labelRight,hx+h*.4+canvas.textWidth(a.total_h,h*.35)/2);}
        }
        if(a.isotope)canvas.text(a.isotope,x-h*.52,y-h*.5,h*.34,`atom ${i} isotope`);
        if(a.charge) {const text=(Math.abs(a.charge)!==1?Math.abs(a.charge):'')+(a.charge>0?'+':'−'),size=Math.max(10,Math.round(h*.34));canvas.text(text,labelRight+Math.max(5,h*.08)+canvas.textWidth(text,size,true)/2,y-h*.5,size,`atom ${i} formal charge`,true);}
      }
      lines.forEach(([line,w],i)=>{let cursor=width/2-w/2+nameH*.09;const y=30+nameH/2+i*lineH;for(const [ch,gw] of line){const x=cursor+gw/2;cursor+=gw+nameH*.18;if(ch===' ')continue;if(ch==='-')canvas.rod([x-nameH*.2,y],[x+nameH*.2,y],'name hyphen');else canvas.glyph(ch,glyphs.get(ch),x,y,nameH,'name '+ch);}});
      const svg=canvas.svg(),svgBlob=new Blob([svg],{type:'image/svg+xml'});svgURL=URL.createObjectURL(svgBlob);
      const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Artwork image could not be decoded.'));image.src=svgURL;});
      const png=document.createElement('canvas');png.width=width;png.height=height;png.getContext('2d').drawImage(image,0,0);
      const pngBlob=await new Promise(resolve=>png.toBlob(resolve,'image/png'));if(!pngBlob)fail('image_export_failed','The PNG could not be created.');
      const warnings=[];
      if(conventional.size)warnings.push('Conventional chemical text preserves element case for: '+[...conventional].sort().join(', ')+'.');
      return {status:'rendered',png_url:URL.createObjectURL(pngBlob),svg_url:svgURL,missing_letters:[],warnings,width,height,
        provenance:{atom_screen_coordinates:coords,placements:canvas.placements,bond_orders:bonds.map(b=>b.order),ring_bond_style:'Outer ring strokes meet chemical vertices; inward secondary whole-protein stroke.',boundary:'Static protein artwork; whole assets, rigid rotation and uniform scaling only.'}};
    } catch(e) {if(svgURL)URL.revokeObjectURL(svgURL);return {status:'error',code:e.code||'artwork_failed',error:e.message||'Artwork could not be created.',missing_letters:[],warnings:[]};}
  }
  function revoke(result) {for(const key of ['png_url','svg_url'])if(result?.[key]?.startsWith('blob:'))URL.revokeObjectURL(result[key]);}
  window.ProteinArtwork=Object.freeze({render,revoke});
})();
