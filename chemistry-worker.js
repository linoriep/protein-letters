/* Same-origin dedicated chemistry worker. RDKit embind stays outside page CSP. */
'use strict';
importScripts('./vendor/rdkit/RDKit_minimal.js');
const window = self;
/* Browser-local chemistry using pinned, same-origin RDKit MinimalLib. */
'use strict';
(() => {
  const ELEMENTS = 'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' ');
  const SYMBOLS = new Set(ELEMENTS);
  let modulePromise;
  async function ready() {
    if (!modulePromise) modulePromise = window.initRDKitModule({locateFile: file => new URL('./vendor/rdkit/' + file, location.href).href}).catch(error => { modulePromise=null;throw error; });
    return modulePromise;
  }
  function fail(message) { throw new Error(message); }
  function field(value, width) { return String(value).padStart(width, ' '); }
  function graphMolblock(graph) {
    if (!graph || !Array.isArray(graph.atoms) || !Array.isArray(graph.bonds) || !graph.atoms.length || graph.atoms.length > 240 || graph.bonds.length > 360) fail('Use up to 120 heavy atoms and 240 total atoms.');
    const atoms = graph.atoms, seen = new Set(), charges = [], isotopes = [];
    const lines = ['Protein Letters', '  Browser sketch    2D', '', field(atoms.length,3)+field(graph.bonds.length,3)+'  0  0  0  0  0  0  0  0999 V2000'];
    atoms.forEach((atom,index) => {
      if (!atom || !SYMBOLS.has(atom.element) || !Number.isFinite(atom.x) || !Number.isFinite(atom.y) || Math.abs(atom.x)>10000 || Math.abs(atom.y)>10000) fail('Use valid elements and finite drawing coordinates.');
      if (['stereo','chirality','chiral_tag'].some(key => key in atom)) fail('Use a SMILES string to retain stereochemistry.');
      const charge = atom.charge ?? 0, isotope = atom.isotope ?? 0;
      if (!Number.isInteger(charge) || Math.abs(charge)>8 || !Number.isInteger(isotope) || isotope<0 || isotope>400) fail('Unsupported atom charge or isotope.');
      if (atom.radical_electrons) fail('Radical artwork is not supported.');
      const xyz=[atom.x/57,-atom.y/57,0].map(value=>value.toFixed(4).padStart(10,' ')).join('');
      lines.push(xyz+' '+atom.element.padEnd(3,' ')+' 0  0  0  0  0  0  0  0  0  0  0  0');
      if (charge) charges.push([index+1,charge]);
      if (isotope) isotopes.push([index+1,isotope]);
    });
    graph.bonds.forEach(bond => {
      if (!bond || !Number.isInteger(bond.a) || !Number.isInteger(bond.b) || bond.a<0 || bond.b<0 || bond.a>=atoms.length || bond.b>=atoms.length || bond.a===bond.b || ![1,2,3].includes(bond.order)) fail('Use single, double or triple bonds between distinct atoms.');
      if (['stereo','direction','wedge','dash'].some(key => key in bond)) fail('Use a SMILES string to retain bond stereochemistry.');
      const key=[bond.a,bond.b].sort((a,b)=>a-b).join(':');
      if (seen.has(key)) fail('A pair of atoms can have only one bond entry.');
      seen.add(key);
      if (Math.hypot(atoms[bond.a].x-atoms[bond.b].x,atoms[bond.a].y-atoms[bond.b].y)<1e-5) fail('Bond endpoints cannot overlap.');
      lines.push(field(bond.a+1,3)+field(bond.b+1,3)+field(bond.order,3)+'  0  0  0  0');
    });
    for (const [kind,items] of [['CHG',charges],['ISO',isotopes]]) for (let i=0;i<items.length;i+=8) {
      const chunk=items.slice(i,i+8);lines.push('M  '+kind+field(chunk.length,3)+chunk.map(([atom,value])=>field(atom,4)+field(value,4)).join(''));
    }
    lines.push('M  END');return lines.join('\n')+'\n';
  }
  function formula(atoms) {
    const counts = new Map();let charge=0;
    for(const atom of atoms) { counts.set(atom.element,(counts.get(atom.element)||0)+1);if(atom.total_h) counts.set('H',(counts.get('H')||0)+atom.total_h);charge+=atom.charge; }
    const order=[...counts.keys()].sort();if(counts.has('C')) { order.splice(order.indexOf('C'),1);order.unshift('C');if(counts.has('H')){order.splice(order.indexOf('H'),1);order.splice(1,0,'H');} }
    return order.map(symbol=>symbol+(counts.get(symbol)>1?counts.get(symbol):'')).join('')+(charge?(charge>0?'+':'−')+(Math.abs(charge)>1?Math.abs(charge):''):'');
  }
  async function prepare(request) {
    if (!request || typeof request!=='object' || Array.isArray(request)) fail('Provide one molecular input.');
    const sources=['smiles','molblock','graph'].filter(key=>request[key]!==undefined&&request[key]!==null);
    if(sources.length!==1) fail('Provide one SMILES string or molecular sketch.');
    const source=sources[0];let input=request[source];
    if(source==='graph') input=graphMolblock(input);
    else if(typeof input!=='string'||!input.trim()||input.length>100000) fail('Use a nonempty molecular input under 100,000 characters.');
    const RDKit=await ready();let mol;
    try {
      mol=RDKit.get_mol(input,JSON.stringify({removeHs:false}));
      if(!mol||!mol.is_valid()) fail('The molecule could not be parsed or has invalid valence.');
      let json=JSON.parse(mol.get_json()),data=json.molecules?.[0];
      if(!data||json.molecules.length!==1) fail('The molecule could not be read.');
      if(source==='smiles'||!data.conformers?.length||data.conformers[0].dim!==2) { mol.set_new_coords();json=JSON.parse(mol.get_json());data=json.molecules[0]; }
      const defaults=json.defaults?.atom||{},bondDefaults=json.defaults?.bond||{},coords=data.conformers?.[0]?.coords;
      if(!Array.isArray(coords)||coords.length!==data.atoms.length) fail('The molecule has no usable 2D coordinates.');
      const atoms=data.atoms.map((raw,index)=>{
        const a={...defaults,...raw},element=ELEMENTS[a.z-1],xy=coords[index];
        if(!element||!Array.isArray(xy)||!xy.every(Number.isFinite)) fail('Query atoms or invalid coordinates are unsupported.');
        return {element,x:xy[0],y:-xy[1],charge:a.chg||0,isotope:a.isotope||0,total_h:a.impHs||0,radical_electrons:a.nRad||0};
      });
      if(!atoms.length||atoms.length>240||atoms.filter(a=>a.element!=='H').length>120) fail('Use up to 120 heavy atoms and 240 total atoms.');
      if(atoms.some(a=>a.radical_electrons)) fail('Radical artwork is not supported.');
      const bonds=data.bonds.map(raw=>{const b={...bondDefaults,...raw};if(![1,2,3].includes(b.bo)||!Array.isArray(b.atoms)||b.atoms.length!==2) fail('Unsupported bond type.');return {a:b.atoms[0],b:b.atoms[1],order:b.bo};});
      const representation=data.extensions?.find(extension=>extension.name==='rdkitRepresentation')||{};
      const rings=Array.isArray(representation.atomRings)?representation.atomRings:[];
      const stereo=data.atoms.some(a=>a.stereo&&a.stereo!=='unspecified')||data.bonds.some(b=>b.stereo&&b.stereo!=='unspecified')||(representation.cipCodes||[]).length>0||(source==='smiles'&&/[@/\\]/.test(input))||(source==='molblock'&&input.split(/\r?\n/)[3]?.slice(12,15).trim()==='1');
      return {schema_version:1,status:'prepared',canonical_smiles:mol.get_smiles(),molblock:mol.get_molblock(),formula:formula(atoms),graph:{atoms,bonds,rings,aromaticBonds:representation.aromaticBonds || []},has_stereochemistry:Boolean(stereo),graph_preserves_stereo:false,stereo_policy:'Original molblock retains stereochemistry. Editing and protein artwork reject explicit stereochemistry.',warnings:[],missing_letters:[],rdkit_version:RDKit.version()};
    } catch(error) { if(error instanceof Error) throw error;fail('The molecule has invalid chemistry or unsupported annotations.'); }
    finally { if(mol) mol.delete(); }
  }
  window.ProteinChemistry={ready,prepare,supportsElement: element => SYMBOLS.has(element)};
})();

self.addEventListener('message', async event => {
  const message=event.data;
  if(!message||!Number.isSafeInteger(message.id)||message.id<1||!['prepare','ready'].includes(message.action)) return;
  try {
    const value=message.action==='prepare'?await self.ProteinChemistry.prepare(message.body):{rdkit_version:(await self.ProteinChemistry.ready()).version()};
    self.postMessage({id:message.id,ok:true,value});
  } catch(error) { self.postMessage({id:message.id,ok:false,error:error instanceof Error?error.message:'The molecular input could not be prepared.'}); }
});
