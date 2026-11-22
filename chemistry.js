/* Browser-local chemistry RPC. No molecular inputs leave this browser. */
'use strict';
(() => {
  const symbols = new Set('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' '));
  const pending=new Map();let worker=null,nextId=0,readyPromise=null;
  function stop(message) {
    if(worker) worker.terminate();worker=null;readyPromise=null;
    for(const task of pending.values()) {clearTimeout(task.timer);task.reject(new Error(message));}
    pending.clear();
  }
  function activeWorker() {
    if(worker) return worker;
    worker=new Worker(new URL('./chemistry-worker.js?v=ring-layout',location.href));
    worker.addEventListener('message',event=>{
      const message=event.data;if(!message||!Number.isSafeInteger(message.id))return;
      const task=pending.get(message.id);if(!task)return;
      clearTimeout(task.timer);pending.delete(message.id);
      if(message.ok===true) task.resolve(message.value);else task.reject(new Error(typeof message.error==='string'?message.error:'The molecule could not be prepared.'));
    });
    worker.addEventListener('error',()=>stop('The chemistry engine could not load. Reload this page or try again.'));
    worker.addEventListener('messageerror',()=>stop('The chemistry response could not be read. Try again.'));
    return worker;
  }
  function request(action,body) {
    return new Promise((resolve,reject)=>{
      let target;try {target=activeWorker();}catch(_){reject(new Error('This browser could not start the chemistry engine.'));return;}
      const id=++nextId,timer=setTimeout(()=>stop('The molecule took too long to prepare. Try a smaller molecule.'),60000);
      pending.set(id,{resolve,reject,timer});
      try {target.postMessage({id,action,body});}catch(_){clearTimeout(timer);pending.delete(id);reject(new Error('The molecular input could not be sent to the chemistry engine.'));}
    });
  }
  function ready() {
    if(!readyPromise) readyPromise=request('ready').catch(error=>{readyPromise=null;throw error;});
    return readyPromise;
  }
  window.ProteinChemistry={ready,prepare:body=>request('prepare',body),supportsElement:element=>symbols.has(element)};
  window.addEventListener('beforeunload',()=>stop('The page was closed.'));
})();
