'use strict';

window.ProteinScan = (() => {
  let worker, sequence=0, current;
  const assets=new Set();
  function urls(blob) {
    const url=URL.createObjectURL(blob);
    assets.add(url);
    return url;
  }
  function cleanup() {
    for (const url of assets) URL.revokeObjectURL(url);
    assets.clear();
  }
  function complete(error,data) {
    if (!current) return;
    const {timer,resolve,reject}=current;
    clearTimeout(timer);current=null;
    if (error) reject(new Error(error));
    else resolve({candidates:data.candidates.map(({preview,projection,...r})=>({...r,image_url:urls(preview),projection_url:urls(projection)}))});
  }
  function getWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('./scan-worker.js',document.baseURI));
    worker.onmessage=event=>{
      const data=event.data;
      if (current?.id!==data.id) return;
      if (data.type==='progress') current.onProgress?.(data.value);
      if (data.type==='result') complete(null,data);
      if (data.type==='error') complete(data.message||'The browser scan failed.');
    };
    worker.onerror=()=>{
      worker?.terminate();worker=null;
      complete('The browser could not run the protein model.');
    };
    return worker;
  }
  function scan({pdbId,filename,content,onProgress}) {
    if (current) return Promise.reject(new Error('One structure scan is already running.'));
    return new Promise((resolve,reject)=>{
      const id=++sequence;
      const queue=getWorker();
      const timer=setTimeout(()=>{
        worker?.terminate();worker=null;
        complete('The browser scan exceeded four minutes. Try a smaller structure.');
      },240000);
      current={id,timer,resolve,reject,onProgress};
      try { queue.postMessage({id,pdbId,filename,content}); }
      catch (error) { complete(error.message); }
    });
  }
  window.addEventListener('pagehide',event=>{if(!event.persisted){worker?.terminate();cleanup();}});
  return {scan,releasePreviews:cleanup};
})();
