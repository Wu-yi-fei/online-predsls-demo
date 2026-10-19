'use strict';

// Cloud browser validation only. Playwright is installed outside the repository.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

async function main() {
  const root = path.resolve(__dirname, '..');
  // Both pages are required build artifacts; a legacy fallback hides a stale build.
  await Promise.all(['index.html','demo.html'].map(file=>fs.access(path.join(root,file))));
  const output = process.env.DEMO_SMOKE_OUTPUT || path.join(root, 'browser-results');
  await fs.mkdir(output, { recursive: true });
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = path.resolve(root, pathname === '/' ? 'index.html' : '.' + pathname);
      if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
      const body = await fs.readFile(file);
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      response.end(body);
    } catch (_) { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const errors = [];
  const startedAt = performance.now(), timings = [];
  const mark = async name => {
    const elapsedSeconds = Number(((performance.now() - startedAt) / 1000).toFixed(3));
    timings.push({ name, elapsedSeconds });
    console.log('Browser milestone ' + name + ' ' + elapsedSeconds + 's');
    await fs.writeFile(path.join(output, 'timings.json'), JSON.stringify({ timings }, null, 2));
  };
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.DEMO_SMOKE_CHANNEL ? { channel: process.env.DEMO_SMOKE_CHANNEL } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const homeURL=origin+'/',demoURL=origin+'/demo.html';
    const withinSettings=async(surface,action)=>{
      const opened=await surface.locator('#pr-adaptation').getAttribute('open')!==null;
      if(!opened)await surface.locator('#pr-adaptation > summary').click();
      await action();
      if(!opened)await surface.locator('#pr-adaptation > summary').click();
    };
    const selectSetting=(surface,id,value)=>withinSettings(surface,()=>surface.locator('#pr-'+id).selectOption(value));
    const stepSetting=surface=>withinSettings(surface,()=>surface.locator('#pr-step').click());
    const useReference=async surface=>{
      await selectSetting(surface,'power-scenario','reference');
      await selectSetting(surface,'noise','1');
    };
    await page.goto(homeURL, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('h1').count(),1);
    assert.equal((await page.locator('h1').textContent()).replace(/\s+/g,' ').trim(),
      'Online System-Level Synthesis for Prediction-Adaptive Networked Control');
    assert.equal(await page.getByText('O-PredSLS Demo',{exact:true}).count(),0,'The paper title is the only page heading');
    assert.equal(await page.locator('#power-response-demo').count(),0,'The paper homepage does not initialize a simulation');
    for(const [href,name] of [['https://jingyu.io/','JingYu'],['https://tongxin.me/','TongxinLi']])
      assert.equal((await page.locator('a[href="'+href+'"]').textContent()).replace(/\s/g,''),name);
    for(const name of ['Paper','PDF']){
      const link=page.getByRole('link',{name,exact:true});
      assert.equal(await link.getAttribute('aria-disabled'),'true');assert.equal(await link.getAttribute('href'),null);
    }
    const demoLink=page.getByRole('link',{name:'Demo',exact:true});
    assert.equal(await demoLink.getAttribute('href'),'demo.html');
    await demoLink.click();await page.waitForURL(demoURL);
    await page.locator('#pr-run').waitFor();
    assert.equal(await page.title(),'O-PredSLS Experiments');
    assert.equal(await page.locator('h1:visible').count(),0,'The experiments page has no large paper heading');
    assert.equal(await page.getByRole('link',{name:'Return to paper homepage',exact:true}).getAttribute('href'),'index.html');
    assert.equal(await page.locator('.research-footer').count(),0,'The redundant footer is removed');
    assert.equal(await page.locator('#pr-experiment').isVisible(),true,'Experiment selection is a primary control');
    assert.equal(await page.locator('#pr-adaptation').getAttribute('open'),null,'Settings start closed');
    assert.equal(await page.locator('#pr-voltage-details').getAttribute('open'),null,'Voltage diagnostics start closed');
    const checkRemovedInterface = async surface => {
      const ids=['auto-compare','all-links','phase-note','fit-detail','scheduled-power','action-note','link-history-details','cost-note','reference-study'];
      for(const id of ids){
        const node=surface.locator('#pr-'+id);
        assert.equal(await node.count(),1,'The bound '+id+' node remains available to replay and rendering');
        assert.equal(await node.isVisible(),false,'Removed '+id+' UI stays hidden');
        assert.equal(await node.evaluate(element=>!!element.parentElement.closest('[hidden]')),true,
          'A hidden ancestor keeps '+id+' out of layout and the keyboard sequence even when rendering changes its own hidden flag');
      }
    };
    await checkRemovedInterface(page);
    assert.equal(await page.locator('#pr-experiment-progress').isVisible(),true,'Both experiment stages are explained before playback');
    assert.equal(await page.locator('[id^="pr-codesign"]').count(),0,'The duplicate communication scatter and ledger are removed');
    assert.equal(await page.locator('#pr-learning-title').textContent(),'Experiment results');
    assert.match(await page.locator('#pr-transition-note').textContent(),/fresh (trial|comparison)/i);
    assert.equal(await page.locator('#pr-restart').textContent(),'Restart demo');
    for(const id of ['step','speed','deploy','attack-mode','strength','view'])assert.equal(await page.locator('#pr-'+id).isVisible(),false,'Advanced '+id+' stays out of the primary flow');
    assert.equal(await page.locator('#pr-matrix-view').isVisible(),true,'Sparsity and weight views stay directly available');
    for(const id of ['network','matrix','voltage','convergence'])assert.equal(await page.locator('#pr-'+id).isVisible(),true,'Main panel '+id+' stays visible');
    await page.screenshot({path:path.join(output,'concise-start-desktop.png'),fullPage:true});
    await selectSetting(page,'speed','32');
    const sample = async () => Number((await page.locator('#pr-clock').textContent()).match(/(\d+) s/)[1]);
    const waitSamples = async count => {
      const initial = await sample();
      await page.waitForFunction(target => {
        const text = document.querySelector('#pr-clock').textContent;
        return Number(text.match(/(\d+) s/)[1]) >= target;
      }, initial + count);
    };
    const pause = async () => {
      if (await page.locator('#pr-run').textContent() === 'Pause') await page.locator('#pr-run').click();
    };

    const checkStageCaptions = async surface => {
      const reading=await surface.evaluate(()=>{
        const panel=document.querySelector('.pr-stage-panel'),summary=document.querySelector('#pr-pulse-summary'),root=document.querySelector('#power-response-demo');
        return {playing:root.powerDemo.getState().playing,width:innerWidth,overflow:document.documentElement.scrollWidth,summary:summary.textContent,summaryDisplay:getComputedStyle(summary).display,
          rows:Array.from(panel.querySelectorAll('.pr-plot-label')).map(row=>({box:row.getBoundingClientRect().toJSON(),spans:Array.from(row.children).filter(node=>node.textContent.trim()).map(node=>{
            const range=document.createRange();range.selectNodeContents(node);
            return {text:node.textContent,font:parseFloat(getComputedStyle(node).fontSize),color:getComputedStyle(node).color,
              box:node.getBoundingClientRect().toJSON(),glyphs:Array.from(range.getClientRects()).map(rect=>rect.toJSON())};
          })})),snapshot:JSON.stringify(root.powerDemo.getSnapshot())};
      });
      assert.ok(reading.overflow<=reading.width+1,'Full timing text cannot widen the page');
      for(const row of reading.rows)for(const span of row.spans){
        assert.ok(span.font>=12,'Voltage and cost captions remain readable');
        for(const glyph of span.glyphs){
          assert.ok(glyph.left>=row.box.left-1&&glyph.right<=row.box.right+1,'Every caption glyph fits the chart label row: '+span.text);
          assert.ok(glyph.top>=row.box.top-1&&glyph.bottom<=row.box.bottom+1,'Wrapping cannot clip caption text');
        }
        const rgb=span.color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2;});
        const luminance=.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
        assert.ok(1.05/(luminance+.05)>=4.5,'Small caption text retains readable contrast');
      }
      if(reading.summary&&reading.width<=650){
        const row=reading.rows[1];assert.equal(row.spans.length,2);
        assert.ok(row.spans[1].box.top>=row.spans[0].box.bottom-1,'Phone timing annotation gets its own line');
      }
      if(!reading.summary)assert.equal(reading.summaryDisplay,'none','An empty forecast caption reserves no extra line');
      if(!reading.playing)assert.equal(await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),reading.snapshot,'Paused caption measurement is read only');
      return reading;
    };

    const checkVoltageMetrics = async surface => {
      await checkStageCaptions(surface);
      const result=await surface.evaluate(()=>{
        const root=document.querySelector('#power-response-demo'),snapshot=root.powerDemo.getSnapshot();
        const rows=Array.from(document.querySelectorAll('#pr-voltage-metrics tr')).map(row=>({
          key:row.dataset.controller,current:Number(row.dataset.currentPu),peak:Number(row.dataset.peakPu),
          limited:Number(row.dataset.limited),shownCurrent:row.querySelector('.current-deviation').textContent,
          shownPeak:row.querySelector('.peak-deviation').textContent,shownLimited:row.querySelector('.limited-inverters').textContent
        }));
        const expected=Object.fromEntries(['online','scalar','static','causal'].map(key=>{
          const deviation=values=>Math.max(...values.map((value,i)=>Math.abs(1+value-snapshot.referenceVoltage[i])));
          const current=deviation(snapshot.states[key]);
          const peak=Math.max(current,...snapshot.initialVoltage.map((value,i)=>Math.abs(value-snapshot.referenceVoltage[i])),
            ...snapshot.history.map(entry=>deviation(entry.states[key])));
          return [key,{current,peak,limited:snapshot.saturation[key].filter(Boolean).length}];
        }));
        return {rows,expected,detail:document.querySelector('#pr-voltage-detail').textContent};
      });
      assert.deepEqual(result.rows.map(row=>row.key),['online','scalar','static','causal'],'All four controller diagnostics remain present');
      for(const row of result.rows) {
        const expected=result.expected[row.key];
        assert.ok(Math.abs(row.current-expected.current)<1e-12,'Current diagnostic matches measured nominal departure');
        assert.ok(Math.abs(row.peak-expected.peak)<1e-12,'Peak includes actual executed states in this phase');
        assert.equal(row.limited,expected.limited);
        assert.equal(row.shownCurrent,(1000*expected.current).toFixed(2));
        assert.equal(row.shownPeak,(1000*expected.peak).toFixed(2));
        assert.equal(row.shownLimited,expected.limited+'/8');
      }
      assert.match(result.detail,/Δ .* mpu/);
    };
    const checkNetworkInspection = async surface => {
      const reading=await surface.evaluate(()=>{
        const root=document.querySelector('#power-response-demo'),state=root.powerDemo.getState(),snapshot=root.powerDemo.getSnapshot();
        const caption=document.querySelector('#pr-network-inspection'),network=document.querySelector('#pr-network');
        const box=caption.getBoundingClientRect(),svg=network.getBoundingClientRect();
        const glyphs=Array.from(caption.querySelectorAll('span')).filter(span=>!span.hidden).map(span=>{
          const range=document.createRange();range.selectNodeContents(span);
          return {text:span.textContent,font:parseFloat(getComputedStyle(span).fontSize),rects:Array.from(range.getClientRects()).map(r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom}))};
        });
        return {state,phase:snapshot.phase,glyphs,hidden:caption.hidden,data:{...caption.dataset},
          source:document.querySelector('#pr-network-inspection-source').textContent,receiver:document.querySelector('#pr-network-inspection-receiver').textContent,
          receiverHidden:document.querySelector('#pr-network-inspection-receiver').hidden,join:document.querySelector('#pr-network-inspection-join').textContent,
          status:document.querySelector('#pr-network-inspection-status').textContent,description:network.getAttribute('aria-description'),
          roles:Array.from(network.querySelectorAll('.bus-node')).filter(node=>node.dataset.inspectionRole!=='none').map(node=>{
            const text=node.querySelector('.bus-number'),rect=text.getBoundingClientRect();
            return {bus:Number(node.dataset.bus),role:node.dataset.inspectionRole,numberY:text.getAttribute('y'),backdrop:node.querySelector('.pr-inspection-number-bg')?.getAttribute('r'),text:text.textContent,font:parseFloat(getComputedStyle(text).fontSize),
              left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom};}),
          backdrops:network.querySelectorAll('.pr-inspection-number-bg').length,box:{left:box.left,right:box.right,top:box.top,bottom:box.bottom},svg:{left:svg.left,right:svg.right,top:svg.top,bottom:svg.bottom},
          inspectedColumnFont:parseFloat(getComputedStyle(document.querySelector('#pr-matrix .matrix-columns text[data-inspected="true"]')||caption).fontSize),
          selectedRowFont:parseFloat(getComputedStyle(document.querySelector('#pr-matrix .matrix-rows g[aria-pressed="true"] text')||caption).fontSize)};
      });
      const {state}=reading,active=state.inspectedSource!==null&&[5,7,8,12,14,18,21,24].includes(state.selectedBus);
      assert.equal(reading.hidden,!active,'Role caption is contextual, not another always visible diagnostic');
      if(!active){assert.equal(reading.source,'');assert.equal(reading.roles.length,0);assert.equal(reading.backdrops,0,'Inspection-only number backdrops clear immediately');return;}
      const local=state.inspectedSource===state.selectedBus,connected=local||!reading.description.includes('No link');
      assert.equal(reading.data.source,String(state.inspectedSource));assert.equal(reading.data.receiver,String(state.selectedBus));
      assert.equal(reading.data.local,String(local));assert.equal(reading.data.connected,String(connected));
      assert.equal(reading.data.context,state.historyIndex!==null?'history':reading.phase==='deployment'?'deployed':'candidate');
      assert.equal(reading.source,(local?'Source and inverter ':'Source ')+state.inspectedSource);
      assert.equal(reading.receiver,local?'':'Inverter '+state.selectedBus);assert.equal(reading.receiverHidden,local);
      assert.equal(reading.join,local?'':connected?'→':'·','Never imply a connection for an absent link');
      assert.equal(reading.status,reading.description.split(' · ').slice(1).join(' · '));
      assert.equal(reading.roles.length,local?1:2);assert.equal(reading.backdrops,local?1:2);
      for(const mark of reading.roles){
        assert.equal(mark.text,String(mark.bus));assert.equal(mark.numberY,'4');assert.equal(mark.backdrop,'11');assert.ok(mark.font>=12,'Inspected bus number is readable');
        assert.ok(mark.left>=reading.svg.left-1&&mark.right<=reading.svg.right+1&&mark.top>=reading.svg.top-1&&mark.bottom<=reading.svg.bottom+1,'Role number stays inside the actual feeder');
      }
      for(const span of reading.glyphs){assert.ok(span.font>=12);for(const rect of span.rects)assert.ok(rect.left>=reading.box.left-1&&rect.right<=reading.box.right+1&&rect.top>=reading.box.top-1&&rect.bottom<=reading.box.bottom+1,'Full role caption fits without clipping');}
      assert.ok(reading.inspectedColumnFont>=12&&reading.selectedRowFont>=12,'Selected source column and receiver row remain readable');
    };
    const checkMatrixGeometry = async surface => {
      const before=await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot()));
      assert.equal(await surface.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getState().playing),false,'Measure labels on a paused actual trial');
      await surface.waitForFunction(()=>{const svg=document.querySelector('#pr-matrix');return Math.abs(svg.viewBox.baseVal.width-svg.getBoundingClientRect().width)<1;});
      await surface.locator('#pr-matrix').scrollIntoViewIfNeeded();
      const result=await surface.evaluate(()=>{
        const svg=document.querySelector('#pr-matrix');
        const box=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
        const text=node=>({label:node.firstChild?.nodeValue,box:box(node),font:parseFloat(getComputedStyle(node).fontSize)});
        return {frame:box(svg),sources:Array.from(svg.querySelectorAll('.matrix-columns text')).map(node=>({...text(node),bus:node.__data__})),
          rows:Array.from(svg.querySelectorAll('.matrix-rows g')).map(node=>{const point=svg.createSVGPoint(),centre=point.matrixTransform(node.getScreenCTM());return {...text(node.querySelector('text')),bus:node.__data__,centreY:centre.y};}),
          titles:Array.from(svg.querySelectorAll('.matrix-axis')).map(text),
          cells:Array.from(svg.querySelectorAll('.matrix-cell')).map(node=>{const r=node.getBoundingClientRect(),hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2)?.closest('.matrix-cell');return {source:Number(node.dataset.source),receiver:Number(node.dataset.receiver),connected:node.dataset.connected,box:box(node),hitSource:Number(hit?.dataset.source),hitReceiver:Number(hit?.dataset.receiver)};}),
          page:document.documentElement.scrollWidth,viewport:innerWidth};
      });
      assert.deepEqual(result.sources.map(x=>x.bus),Array.from({length:23},(_,i)=>i+2),'All 23 source columns remain in order');
      assert.deepEqual(result.rows.map(x=>x.bus),[5,7,8,12,14,18,21,24],'All eight inverter rows remain in order');
      assert.equal(result.cells.length,184,'Every actual inspection cell remains available');
      assert.deepEqual(result.titles.map(x=>x.label),['Source bus','Inverter']);
      const labels=[...result.sources,...result.rows,...result.titles];
      const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>.5&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.5;
      for(let i=0;i<labels.length;i++){
        const a=labels[i];assert.ok(a.font>=12,'Every matrix number and axis title is at least 12 px');
        assert.ok(a.box.left>=result.frame.left-.5&&a.box.right<=result.frame.right+.5&&a.box.top>=result.frame.top-.5&&a.box.bottom<=result.frame.bottom+.5,'Every label fits inside the matrix drawing '+a.label);
        for(let k=i+1;k<labels.length;k++)assert.ok(!overlap(a.box,labels[k].box),'Matrix labels do not overlap '+a.label+' and '+labels[k].label);
      }
      for(const cell of result.cells){
        assert.equal(cell.hitSource,cell.source);assert.equal(cell.hitReceiver,cell.receiver,'Every actual cell centre targets its own receiver');
        const column=result.sources.find(x=>x.bus===cell.source),row=result.rows.find(x=>x.bus===cell.receiver),centreX=(cell.box.left+cell.box.right)/2;
        assert.ok(Math.abs((column.box.left+column.box.right)/2-centreX)<.6,'Source number stays aligned with its actual column');
        assert.ok(column.box.bottom<cell.box.top,'Source labels stay above the support cells');
        assert.ok(Math.abs(row.centreY-(cell.box.top+cell.box.bottom)/2)<.6,'Inverter number stays aligned with its actual row');
      }
      assert.ok(result.page<=result.viewport+1,'Larger matrix labels never widen the page');
      assert.equal(await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),before,'Label measurement changes no plant, forecasts, support or cost');
    };

    const checkNetworkGeometry = async surface => {
      const before=await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot()));
      await surface.waitForFunction(()=>Number(document.querySelector('#pr-network').getAttribute('height'))===(innerWidth<=650?360:220));
      await surface.locator('#pr-network').scrollIntoViewIfNeeded();
      const geometry=await surface.evaluate(()=>{
        const svg=document.querySelector('#pr-network'),frame=svg.getBoundingClientRect(),view=svg.viewBox.baseVal;
        const box=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
        const buses=Array.from(svg.querySelectorAll('.bus-node')).map(node=>{
          const label=node.querySelector('.bus-number'),point=svg.createSVGPoint();point.x=0;point.y=0;
          const centre=point.matrixTransform(node.getScreenCTM()),hit=document.elementFromPoint(centre.x,centre.y)?.closest('.bus-node');
          const local=point.matrixTransform(node.transform.baseVal.getItem(0).matrix);
          return {bus:Number(node.dataset.bus),text:label.textContent,label:box(label),disc:box(node.querySelector('.pe-disc')),
            font:parseFloat(getComputedStyle(label).fontSize),hit:Number(hit?.dataset.bus),
            x:local.x,y:local.y,normalX:(local.x-25)/(view.width-54),normalY:(local.y-26)/(view.height-54)};
        });
        return {width:innerWidth,height:parseFloat(svg.getAttribute('height')),frame:box(svg),page:document.documentElement.scrollWidth,
          buses,edges:Array.from(svg.querySelectorAll('.physical line')).map(line=>({pair:line.__data__,x1:Number(line.getAttribute('x1')),y1:Number(line.getAttribute('y1')),x2:Number(line.getAttribute('x2')),y2:Number(line.getAttribute('y2'))})),
          expectedEdges:window.PowerDemo.constants.edges};
      });
      assert.equal(geometry.height,geometry.width<=650?360:220,'Only the phone drawing receives extra vertical room');
      assert.equal(geometry.buses.length,24);assert.equal(geometry.edges.length,23);
      assert.deepEqual(geometry.edges.map(edge=>edge.pair),geometry.expectedEdges,'Same constructed physical feeder connections');
      const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>.5&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.5;
      for(const bus of geometry.buses){
        assert.equal(bus.text,String(bus.bus));assert.equal(bus.hit,bus.bus,'Each actual bus centre targets itself, not a neighbour or label');
        assert.ok(bus.label.left>=geometry.frame.left-1&&bus.label.right<=geometry.frame.right+1&&bus.label.top>=geometry.frame.top-1&&bus.label.bottom<=geometry.frame.bottom+1,'Every bus number fits the drawing');
        if(geometry.width<=650){
          assert.ok(bus.font>=12,'All phone bus numbers are readable without hover');
          for(const other of geometry.buses)if(other.bus!==bus.bus){
            assert.equal(overlap(bus.label,other.label),false,'Phone bus labels cannot overlap '+bus.bus+' and '+other.bus);
            assert.equal(overlap(bus.label,other.disc),false,'A phone number cannot cover another equipment icon '+bus.bus+' and '+other.bus);
          }
        }
      }
      for(const edge of geometry.edges){
        const from=geometry.buses.find(bus=>bus.bus===edge.pair[0]),to=geometry.buses.find(bus=>bus.bus===edge.pair[1]);
        for(const [actual,expected] of [[edge.x1,from.x],[edge.y1,from.y],[edge.x2,to.x],[edge.y2,to.y]])assert.ok(Math.abs(actual-expected)<.01,'Physical line remains attached to its actual bus');
      }
      assert.ok(geometry.page<=geometry.width+1);
      assert.equal(await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),before,'Geometry inspection leaves all physical states, forecasts, support and costs unchanged');
      return geometry.buses.map(({bus,normalX,normalY})=>({bus,normalX,normalY}));
    };
    const captureNetworkInspection = async surface => {
      await checkNetworkGeometry(surface);
      await checkNetworkInspection(surface);
      const width=surface.viewportSize().width,phase=await surface.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getSnapshot().phase),before=await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot()));
      const preview=await surface.locator('.pr-network-panel').screenshot({path:path.join(output,'network-inspection-'+width+'-'+phase+'.jpg'),type:'jpeg',quality:90});
      console.log('CLOUD_ROLE_PREVIEW_'+width+'_'+phase+' '+preview.toString('base64'));
      assert.equal(await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),before,'Screenshot review changes no actual trial');
    };
    const checkForecastObservation = async surface => {
      await checkNetworkInspection(surface);
      const reading=await surface.evaluate(()=>{
        const root=document.querySelector('#power-response-demo'),snapshot=root.powerDemo.getSnapshot(),state=root.powerDemo.getState();
        const panel=document.querySelector('#pr-forecast-observation'),values=document.querySelector('#pr-forecast-values');
        const active=state.inspectedSource!==null&&[5,7,8,12,14,18,21,24].includes(state.selectedBus);
        const sample=snapshot.lastSample,index=state.inspectedSource-1;
        return {hidden:panel.hidden,valuesHidden:values.hidden,data:{...panel.dataset},active,
          expected:active&&state.historyIndex===null&&sample?{source:state.inspectedSource,receiver:state.selectedBus,
            action:sample.t,issuedAt:Math.max(0,sample.t-4),observedAt:sample.t+1,
            forecast:sample.forecast[index],realized:sample.disturbance[index],error:sample.forecast[index]-sample.disturbance[index]}:null,
          shown:Object.fromEntries(['forecast','realized','error'].map(key=>[key,document.querySelector('#pr-observed-'+key).textContent])),
          context:document.querySelector('#pr-forecast-support').textContent,phase:snapshot.phase,experiment:snapshot.experiment,
          timing:document.querySelector('#pr-forecast-timing').textContent,
          units:document.querySelector('#pr-forecast-units').textContent,unitsTitle:document.querySelector('#pr-forecast-units').title,describedBy:values.getAttribute('aria-describedby'),
          typography:Array.from(panel.querySelectorAll(':scope > .pr-caption, .pr-forecast-values dt, .pr-forecast-values dd')).filter(node=>!node.hidden&&getComputedStyle(node).display!=='none').map(node=>{
            const range=document.createRange();range.selectNodeContents(node);
            return {tag:node.tagName,id:node.id,font:parseFloat(getComputedStyle(node).fontSize),weight:getComputedStyle(node).fontWeight,
              bounds:node.getBoundingClientRect().toJSON(),glyphs:Array.from(range.getClientRects()).map(box=>box.toJSON())};
          })};
      });
      assert.equal(reading.hidden,!reading.active);
      assert.equal(reading.valuesHidden,!reading.expected);
      assert.equal(reading.data.available,String(!!reading.expected));
      if(reading.expected){
        for(const [key,value] of Object.entries(reading.expected))assert.equal(Number(reading.data[key]),value,'Observed '+key+' matches the actual revealed pair');
        for(const key of ['forecast','realized','error'])assert.equal(reading.shown[key],(1000*reading.expected[key]).toFixed(3));
        assert.match(reading.context,reading.phase==='discovery'?/Dense messages · Candidate links/:reading.experiment==='prediction'?/All sources available · Inverter/:/(Selected|Excluded) · Inverter .*Fixed links/);
        const pair=reading.expected;
        assert.equal(reading.timing,'Source '+pair.source+' · Issued '+pair.issuedAt+' s · Target '+pair.action+' s · Revealed '+pair.observedAt+' s','Observed pair timing follows actual issue target reveal order');
        assert.equal(reading.describedBy,'pr-forecast-units');
        assert.match(reading.units,/mpu.*1 mpu = 0.001 pu/);
        assert.match(reading.unitsTitle,/Disturbance forcing.*unforecast power changes/);
        for(const item of reading.typography){
          assert.ok(item.font>=(item.tag==='DD'?16:12),'Observation values and labels remain readable');
          for(const glyph of item.glyphs)assert.ok(glyph.left>=item.bounds.left-1&&glyph.right<=item.bounds.right+1,'Every observation glyph wraps inside its existing column');
          if(item.id==='pr-observed-error')assert.ok(Number(item.weight)>=600,'Signed error has a stable text emphasis, not a success color');
        }
      }else assert.equal(reading.data.forecast,'','Unavailable observations clear stale numeric metadata');
    };
    const checkForecastSettings = async surface => {
      const reading=await surface.evaluate(()=>{
        const snapshot=document.querySelector('#power-response-demo').powerDemo.getSnapshot(),node=document.querySelector('#pr-scenario-description');
        return {experiment:snapshot.experiment,beta:snapshot.beta,faults:snapshot.faults,sources:snapshot.predictionDiagnostics?.sourceBuses || Array.from({length:23},(_,i)=>i+2),
          data:{...node.dataset},text:node.textContent,title:node.title,description:node.getAttribute('aria-description'),font:parseFloat(getComputedStyle(node).fontSize),box:node.getBoundingClientRect().toJSON()};
      });
      assert.equal(reading.data.forecastSettings,String(reading.experiment==='communication'));
      if(reading.experiment!=='communication')return;
      const noisy=reading.sources.filter(bus=>reading.faults.includes(bus)).length;
      assert.equal(Number(reading.data.noisy),noisy);assert.equal(Number(reading.data.quiet),reading.sources.length-noisy);
      assert.equal(Number(reading.data.sourceCount),reading.sources.length);assert.equal(Number(reading.data.beta),reading.beta);
      assert.equal(reading.data.noiseEnabled,String(reading.beta>0));
      assert.match(reading.text,/^Forecast noise SD \(mpu\) · quiet .* · noisy /);
      const quietValues=reading.data.quietSd.split(',').filter(Boolean).map(Number),noisyValues=reading.data.noisySd.split(',').filter(Boolean).map(Number);
      assert.equal(quietValues.length,reading.sources.length-noisy);assert.equal(noisyValues.length,noisy);
      assert.ok([...quietValues,...noisyValues].every(value=>Number.isFinite(value)&&value>=0));
      if(reading.beta===0)assert.ok([...quietValues,...noisyValues].every(value=>value===0));
      assert.match(reading.title,/SD is the configured additive-noise standard deviation in forcing coordinates/);assert.equal(reading.description,reading.title);
      assert.ok(reading.font>=12);assert.ok(reading.box.left>=-1&&reading.box.right<=surface.viewportSize().width+1,'Forecast heading fits the viewport');
    };

    const checkControllerKey = async (surface,interact=false) => {
      const read=()=>surface.evaluate(()=>{
        const key=document.querySelector('#pr-controller-key'),dashboard=document.querySelector('.pr-dashboard');
        return {role:key.getAttribute('role'),label:key.getAttribute('aria-label'),before:!!(key.compareDocumentPosition(dashboard)&Node.DOCUMENT_POSITION_FOLLOWING),
          keyBox:key.getBoundingClientRect().toJSON(),dashboardBox:dashboard.getBoundingClientRect().toJSON(),
          buttons:Array.from(key.querySelectorAll('button')).map(button=>({key:button.dataset.series,text:button.textContent,pressed:button.getAttribute('aria-pressed'),
            hidden:button.hidden,font:parseFloat(getComputedStyle(button).fontSize),opacity:parseFloat(getComputedStyle(button).opacity),
            color:getComputedStyle(button).color,box:button.getBoundingClientRect().toJSON()}))};
      });
      const reading=await read(),phone=surface.viewportSize().width<650;
      assert.equal(reading.role,'group');assert.equal(reading.label,'Controller curves');
      assert.equal(reading.before,true);assert.ok(reading.keyBox.bottom<=reading.dashboardBox.top,'Shared method key precedes all four plots');
      assert.deepEqual(reading.buttons.map(button=>button.key),['online','scalar','static','causal']);
      for(const button of reading.buttons){
        assert.equal(button.hidden,false);assert.ok(button.text.trim().length>0);assert.ok(button.font>=12);
        assert.ok(button.box.height>=(phone?44:32)-.01);
        if(phone)assert.ok(button.box.width>=44);
        assert.ok(button.box.left>=-1&&button.box.right<=surface.viewportSize().width+1);
        const rgb=button.color.match(/[\d.]+/g).slice(0,3).map(Number).map(value=>{value/=255;return value<=.04045?value/12.92:Math.pow((value+.055)/1.055,2.4);});
        const luminance=.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
        assert.ok(1.05/(luminance+.05)>=4.5,'Readable method text on the white surface');
      }
      for(let i=0;i<reading.buttons.length;i++)for(let j=i+1;j<reading.buttons.length;j++){
        const a=reading.buttons[i].box,b=reading.buttons[j].box;
        assert.ok(a.right<=b.left+.1||b.right<=a.left+.1||a.bottom<=b.top+.1||b.bottom<=a.top+.1,'Method targets do not overlap');
      }
      if(!interact)return;
      const before=await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot()));
      assert.equal(await surface.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getState().playing),false);
      const activate=async(key,index)=>{
        const button=surface.locator('#pr-controller-key [data-series="'+key+'"]');
        if(phone)await button.tap();else {await button.focus();await button.press(index%2?'Space':'Enter');}
      };
      for(const [index,key] of ['online','scalar','static'].entries())await activate(key,index);
      let hidden=await read();
      for(const key of ['online','scalar','static']){
        const button=hidden.buttons.find(button=>button.key===key);assert.equal(button.pressed,'false');assert.equal(button.opacity,1,'Hidden curves retain readable labels');
      }
      for(const chart of ['pr-stage','pr-voltage'])assert.equal(await surface.locator('#'+chart+' path.data-series').count(),1);
      await activate('causal',0);
      assert.equal(await surface.locator('#pr-controller-key [data-series="causal"]').getAttribute('aria-pressed'),'true','Last curve cannot be hidden');
      for(const [index,key] of ['online','scalar','static'].entries())await activate(key,index);
      for(const chart of ['pr-stage','pr-voltage'])assert.equal(await surface.locator('#'+chart+' path.data-series').count(),4);
      if(await surface.locator('#pr-cost').isVisible()){
        assert.equal(await surface.locator('#pr-cost path.data-series').count(),4);
        assert.equal(await surface.locator('#pr-cost-detail tr').count(),4);
      }
      assert.equal(await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),before,'Key operation preserves every measured sample and cost');
      assert.equal(await surface.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getState().playing),false,'Native key activation cannot trigger playback');
    };
    const checkDashboardLayout = async surface => {
      await surface.waitForFunction(()=>{
        const grid=document.querySelector('.pr-dashboard'),panels=Array.from(grid.children);
        if(innerWidth<=650)return !grid.hasAttribute('data-layout')&&panels.every(panel=>!panel.style.gridRow&&!panel.style.gridColumn);
        return grid.dataset.layout==='columns'&&panels.every(panel=>Number(panel.style.gridRowEnd.replace('span ',''))===Math.ceil(panel.getBoundingClientRect().height));
      });
      const result=await surface.evaluate(()=>{
        const grid=document.querySelector('.pr-dashboard'),panels=Array.from(grid.children);
        return {layout:grid.dataset.layout,width:innerWidth,page:document.documentElement.scrollWidth,
          order:panels.map(panel=>panel.className),boxes:panels.map(panel=>{const b=panel.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height};})};
      });
      const [network,matrix,voltage,cost]=result.boxes;
      assert.equal(result.boxes.length,4,'Exactly four main panels');
      for(const [index,name] of ['pr-network-panel','pr-matrix-panel','pr-stage-panel','pr-learning-panel'].entries())assert.ok(result.order[index].includes(name),'Logical reading order is unchanged');
      assert.ok(result.page<=result.width+1,'Independent columns never widen the viewport');
      if(result.width>650){
        assert.equal(result.layout,'columns');
        assert.ok(Math.abs(network.y-matrix.y)<1);
        assert.ok(Math.abs(network.x-voltage.x)<1&&Math.abs(matrix.x-cost.x)<1);
        assert.ok(matrix.x-network.right>=10);
        for(const gap of [voltage.y-network.bottom,cost.y-matrix.bottom])assert.ok(gap>=11&&gap<=14,'Each column follows its own actual content with a 12 px gap');
      }else{
        assert.equal(result.layout,undefined);
        for(let i=1;i<4;i++)assert.ok(result.boxes[i].y-result.boxes[i-1].bottom>=9,'Phone retains nonoverlapping logical order');
      }
      return result;
    };
    const exerciseDashboardLayout = async surface => {
      const before=await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot()));
      const viewport=surface.viewportSize(),original=await checkDashboardLayout(surface);
      const networkPositions=await checkNetworkGeometry(surface);
      await checkMatrixGeometry(surface);
      if(viewport.width>650){
        // Removing the duplicate design panel makes the network shorter than the matrix.
        // Verify its own content ends cleanly instead of assuming which column is taller.
        const footerGap=await surface.evaluate(()=>{const panel=document.querySelector('.pr-network-panel');return panel.getBoundingClientRect().bottom-panel.querySelector('.pr-panel-foot').getBoundingClientRect().bottom;});
        assert.ok(footerGap>=8&&footerGap<=20,'Network ends after its actual bus readout without a duplicate results panel');
        await surface.locator('#pr-matrix .matrix-cell[data-receiver="5"][data-source="7"]').click();
        const inspected=await checkDashboardLayout(surface);
        assert.ok(inspected.boxes[1].height>original.boxes[1].height,'Actual source details expand their own column');
        await checkRemovedInterface(surface);
        const eventPreviewWidths=new Set();
        for(const width of [390,768,1440,650,651,viewport.width]){
          await surface.setViewportSize({width,height:1000});
          await checkDashboardLayout(surface);
          await checkMatrixGeometry(surface);
          await checkEventMarkers(surface);
          if([390,1440].includes(width)&&!eventPreviewWidths.has(width)){
            eventPreviewWidths.add(width);
            for(const [name,selector] of [['voltage','.pr-stage-panel'],['cost','.pr-learning-panel']]){
              const preview=await surface.locator(selector).screenshot({path:path.join(output,'cycle-markers-'+width+'-'+name+'.jpg'),type:'jpeg',quality:90});
              console.log('CLOUD_CYCLE_PREVIEW_'+width+'_'+name+' '+preview.toString('base64'));
            }
          }
          const positions=await checkNetworkGeometry(surface);
          for(let i=0;i<positions.length;i++)for(const key of ['normalX','normalY'])assert.ok(Math.abs(positions[i][key]-networkPositions[i][key])<1e-6,'Responsive spacing does not change the normalized bus layout');
        }
        await surface.setViewportSize({width:320,height:1000});
        await checkDashboardLayout(surface);await checkMatrixGeometry(surface);
        const matrixPreview=await surface.locator('#pr-matrix').screenshot({path:path.join(output,'matrix-labels-320.jpg'),type:'jpeg',quality:90});
        console.log('CLOUD_MATRIX_LABEL_PREVIEW_320 '+matrixPreview.toString('base64'));
        await surface.setViewportSize(viewport);await checkDashboardLayout(surface);
        await surface.locator('#pr-voltage-details > summary').click();
        await checkDashboardLayout(surface);
        await surface.locator('#pr-voltage-details > summary').click();
        await checkDashboardLayout(surface);
        // Reload restores the exact trial, not an inspection-only selection.
        await surface.reload({waitUntil:'networkidle'});
        await checkDashboardLayout(surface);
        await checkRemovedInterface(surface);
      }
      assert.equal(await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),before,'Reflow, disclosures and breakpoint changes preserve exact physical replay and every cost');
    };

    const captureDashboard = async surface => {
      await checkDashboardLayout(surface);await checkMatrixGeometry(surface);
      await checkControllerKey(surface);
      const before=await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),width=surface.viewportSize().width;
      assert.equal(await surface.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getState().playing),false);
      await surface.locator('#power-response-demo').screenshot({path:path.join(output,'four-panels-'+width+'.png')});
      const composite=await surface.locator('.pr-dashboard').screenshot({path:path.join(output,'dashboard-columns-'+width+'.jpg'),type:'jpeg',quality:80});
      console.log('CLOUD_LAYOUT_PREVIEW_'+width+' '+composite.toString('base64'));
      for(const [name,selector] of [['key','#pr-controller-key'],['network','.pr-network-panel'],['matrix','.pr-matrix-panel'],['voltage','.pr-stage-panel'],['cost','.pr-learning-panel']]){
        const preview=await surface.locator(selector).screenshot({path:path.join(output,'panel-'+name+'-'+width+'.jpg'),type:'jpeg',quality:80});
        console.log('CLOUD_PANEL_PREVIEW_'+width+'_'+name+' '+preview.toString('base64'));
      }
      assert.equal(await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),before,'Full panel review preserves the paused physical trial');
    };

    const captureForecastSettings = async surface => {
      await checkForecastSettings(surface);
      const before=await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot()));
      const width=surface.viewportSize().width,header=surface.locator('.pr-scenario-heading');
      await header.screenshot({path:path.join(output,'forecast-settings-'+width+'.png')});
      const preview=await surface.locator('.pr-scenario-heading > div').screenshot({path:path.join(output,'forecast-settings-'+width+'.jpg'),type:'jpeg',quality:90});
      console.log('CLOUD_SETTINGS_PREVIEW_'+width+' '+preview.toString('base64'));
      assert.equal(await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),before,'Heading review cannot alter the paused trial');
    };
    const checkSourceHistory = async surface => {
      await checkForecastSettings(surface);
      const reading=await surface.evaluate(()=>{
        const root=document.querySelector('#power-response-demo'),snapshot=root.powerDemo.getSnapshot(),state=root.powerDemo.getState();
        const window=document.querySelector('#pr-forecast-window'),change=document.querySelector('#pr-forecast-change');
        return {snapshot:{t:snapshot.t,eventLog:snapshot.eventLog,lastSample:snapshot.lastSample?{forecast:snapshot.lastSample.forecast,disturbance:snapshot.lastSample.disturbance}:null},state,window:{...window.dataset},change:{...change.dataset},text:window.textContent,timing:change.textContent};
      });
      const {snapshot,state,window,change}=reading;
      const active=state.inspectedSource!==null&&[5,7,8,12,14,18,21,24].includes(state.selectedBus)&&state.historyIndex===null;
      assert.equal(window.available,String(!!active&&snapshot.t>0));
      if(active&&snapshot.t>0){
        assert.equal(Number(window.count),Math.min(60,snapshot.t));
        assert.equal(Number(window.firstObservedAt),Math.max(1,snapshot.t-59));assert.equal(Number(window.lastObservedAt),snapshot.t);
        assert.ok(Number(window.rmse)>=Math.abs(Number(window.bias))-1e-12);
        assert.match(reading.text,/revealed pairs.*RMSE.*mpu.*Bias.*mpu/);
      }else assert.equal(window.rmse,'','No stale or future statistics');
      const event=active?snapshot.eventLog.filter(event=>event.type==='forecast'&&event.bus===state.inspectedSource).at(-1):null;
      assert.equal(change.available,String(!!event));
      if(event){
        const issuedAt=Math.max(1,event.t),target=issuedAt+4;
        assert.equal(Number(change.changedAt),event.t);assert.equal(Number(change.issuedAt),issuedAt);
        assert.equal(Number(change.firstAction),target);assert.equal(Number(change.pairAt),target+1);
        assert.equal(change.issued,String(snapshot.t>issuedAt));assert.equal(change.observed,String(snapshot.t>target));
        assert.equal(Number(change.pairsInWindow),Math.min(60,Math.max(0,snapshot.t-target)));
      }
      return reading;
    };
    const checkCommandInspection = async surface => {
      const result=await surface.evaluate(()=>{
        const root=document.querySelector('#power-response-demo'),snapshot=root.powerDemo.getSnapshot(),state=root.powerDemo.getState();
        return {snapshot:{lastSample:snapshot.lastSample?{t:snapshot.lastSample.t}:null,commandQ:snapshot.commandQ,saturation:snapshot.saturation},state,rows:Array.from(document.querySelectorAll('#pr-command-rows tr')).map(row=>({
          data:{...row.dataset},shown:Array.from(row.querySelectorAll('td')).map(cell=>cell.textContent),title:row.title
        }))};
      });
      const {snapshot,state,rows}=result,active=state.inspectedSource!==null&&[5,7,8,12,14,18,21,24].includes(state.selectedBus)&&state.historyIndex===null&&snapshot.lastSample;
      assert.equal(rows.length,active?4:0,'No pending or historical commands presented as current');
      if(!active)return;
      assert.deepEqual(rows.map(row=>row.data.controller),['online','scalar','static','causal']);
      for(const row of rows){
        const data=row.data,key=data.controller,source=Number(data.sourceKvar),other=Number(data.otherKvar),feedback=Number(data.feedbackKvar),request=Number(data.requestedKvar),command=Number(data.commandKvar);
        assert.equal(Number(data.source),state.inspectedSource);assert.equal(Number(data.receiver),state.selectedBus);
        assert.equal(Number(data.action),snapshot.lastSample.t);
        assert.ok(Math.abs(source+other+feedback-request)<1e-8,'Parts reconstruct the request');
        assert.equal(command,snapshot.commandQ[key][state.selectedBus-1]);
        assert.ok(Math.abs(command-Math.max(-70,Math.min(70,request)))<1e-8,'Limiter matches actual executed command');
        assert.equal(data.limited,String(snapshot.saturation[key][state.selectedBus-1]));
        assert.ok(Number.isFinite(Number(data.gainNorm)));
        assert.match(row.title,/Temporal source gain norm/);
        const format=value=>(Math.abs(value)<.0005?0:value).toFixed(3);
        assert.deepEqual(row.shown,[...[source,other,feedback,request,command].map(format),Number(data.gainNorm).toPrecision(4)]);
        assert.ok(row.shown[5].length>0,'Temporal source gain is visible without hover');
        if(key==='causal'){assert.equal(source,0);assert.equal(other,0);assert.equal(Number(data.gainNorm),0);}
      }
    };
    const inspectCommandNavigation = async surface => {
      await checkCommandInspection(surface);
      const before=await surface.evaluate(()=>{const root=document.querySelector('#power-response-demo');return {snapshot:JSON.stringify(root.powerDemo.getSnapshot()),state:root.powerDemo.getState(),rows:document.querySelector('#pr-command-rows').textContent};});
      assert.equal(before.state.playing,false);
      const detail=surface.locator('#pr-command-inspector'),opened=await detail.getAttribute('open')!==null;
      if(!opened)await surface.locator('#pr-command-title').click();
      const notes=await detail.evaluate(node=>Array.from(node.querySelectorAll(':scope > p.pr-caption')).map(note=>{
        const copy=note.cloneNode(true);copy.querySelector('#pr-command-scroll-hint')?.remove();
        const box=note.getBoundingClientRect();return {text:copy.textContent,title:note.title,font:parseFloat(getComputedStyle(note).fontSize),left:box.left,right:box.right,viewport:innerWidth};
      }));
      assert.deepEqual(notes.map(note=>note.text),[
        'kvar · Full preview · Before limiting',
        'Request = Source + Other + Feedback · Command ∈ [−70, 70] kvar'
      ],'Concise command notes retain full-preview, additive-command and limiting information');
      assert.equal(notes.length,2,'Keep the two concise notes without adding panels or controls');
      assert.match(notes[0].title,/all forecasts available to the executed command, before saturation/);
      assert.match(notes[1].title,/message-gain norm across the issued preview, in pu command per pu forcing/);
      assert.ok(notes.every(note=>note.font>=12&&note.left>=0&&note.right<=note.viewport+1),'Command qualifications stay readable inside desktop and phone layouts');
      assert.ok(notes.map(note=>note.text).join(' ').split(/\s+/).length<=66,'Keep command notes concise without shrinking their text');
      const scroll=surface.getByRole('region',{name:'Receiver command table',exact:true});
      await scroll.scrollIntoViewIfNeeded();
      const initial=await scroll.evaluate(node=>node.scrollLeft),seen=new Set();
      const maximum=await scroll.evaluate(node=>node.scrollWidth-node.clientWidth);
      await scroll.evaluate(node=>{node.scrollLeft=0;});
      if(maximum>1){
        await scroll.focus();
        for(let i=0;i<6;i++)await scroll.press('ArrowRight');
        await surface.waitForFunction(()=>document.querySelector('.pr-command-scroll').scrollLeft>0);
        await scroll.evaluate(node=>new Promise(resolve=>{
          let last=node.scrollLeft,quietSince=performance.now();
          const settled=()=>{const now=performance.now();if(node.scrollLeft!==last){last=node.scrollLeft;quietSince=now;}
            if(now-quietSince>=250)resolve();else requestAnimationFrame(settled);};
          requestAnimationFrame(settled);
        }));
      }
      for(const [position,fraction] of [['start',0],['middle',.5],['end',1]]){
        await scroll.evaluate((node,fraction)=>{node.scrollLeft=fraction*(node.scrollWidth-node.clientWidth);},fraction);
        await scroll.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const view=await scroll.evaluate(node=>{
          const bounds=node.getBoundingClientRect(),labels=Array.from(node.querySelectorAll('th:first-child')),edge=labels[0].getBoundingClientRect().right;
          const glyph=cell=>{const range=document.createRange();range.selectNodeContents(cell);const box=range.getBoundingClientRect();return {left:box.left,right:box.right};};
          const columns=Array.from(node.querySelectorAll('thead th')).slice(1).map((cell,index)=>({index,label:cell.textContent,...glyph(cell)}));
          const hint=document.querySelector('#pr-command-scroll-hint');
          const whole=Array.from(node.querySelectorAll('thead th')).slice(1).filter(cell=>{const box=cell.getBoundingClientRect();return box.left>=edge-.5&&box.right<=bounds.right+.5;}).map(cell=>cell.textContent);
          return {left:bounds.left,right:bounds.right,edge,page:document.documentElement.scrollWidth,viewport:innerWidth,
            whole,scrollLeft:node.scrollLeft,maximum:node.scrollWidth-node.clientWidth,
            hint:{text:hint.textContent,hidden:hint.hidden,data:{...hint.dataset},font:parseFloat(getComputedStyle(hint).fontSize),box:hint.getBoundingClientRect().toJSON()},
            labels:labels.map(cell=>({text:cell.textContent,left:cell.getBoundingClientRect().left,right:cell.getBoundingClientRect().right,glyph:glyph(cell),background:getComputedStyle(cell).backgroundColor})),
            visible:columns.filter(cell=>cell.left>=edge-.5&&cell.right<=bounds.right+.5).map(cell=>cell.index),
            fonts:Array.from(node.querySelectorAll('th,td')).map(cell=>parseFloat(getComputedStyle(cell).fontSize)),
            cells:node.querySelectorAll('tbody td').length,rows:Array.from(node.querySelectorAll('tbody tr')).map(row=>row.dataset.controller)};
        });
        assert.ok(view.page<=view.viewport+1,'Command panning does not overflow the page');
        assert.deepEqual(view.hint.data.visible?view.hint.data.visible.split('|'):[],view.whole,'Caption names only whole command columns beyond the pinned method names');
        assert.ok(Math.abs(Number(view.hint.data.offset)-view.scrollLeft)<.5,'Caption follows actual native scrolling');
        assert.equal(view.hint.hidden,view.maximum<=1);
        if(view.maximum>1){
          const left=view.scrollLeft>1,right=view.scrollLeft<view.maximum-1;
          assert.equal(view.hint.data.left,String(left));assert.equal(view.hint.data.right,String(right));
          assert.equal(view.hint.text,(view.whole.length?'Visible '+view.whole.join(', ')+' · ':'')+(left&&right?'Scroll both ways':left?'Scroll left':'Scroll right'));
          assert.ok(view.hint.font>=12&&view.hint.box.left>=0&&view.hint.box.right<=view.viewport+1,'Native scroll caption stays readable inside the phone');
        }
        assert.deepEqual(view.rows,['online','scalar','static','causal']);assert.equal(view.cells,24,'All six terms for all four policies remain rendered');
        assert.ok(view.fonts.every(font=>font>=12),'Every command heading and value uses readable type');
        assert.equal(view.labels.length,5);
        for(const label of view.labels){
          assert.ok(Math.abs(label.left-view.left)<1,'Controller names stay at the scroller edge');
          assert.ok(label.glyph.left>=view.left-.5&&label.glyph.right<=view.edge+.5,'Controller text fits the pinned column');
          assert.ok(label.right<=view.right,'Controller names remain visible at every pan position');
          assert.notEqual(label.background,'rgba(0, 0, 0, 0)','Pinned names have an opaque background');
        }
        view.visible.forEach(index=>seen.add(index));
        const width=surface.viewportSize().width,preview=await detail.screenshot({path:path.join(output,'command-navigation-'+width+'-'+position+'.jpg'),type:'jpeg',quality:85});
        console.log('CLOUD_COMMAND_PREVIEW_'+width+'_'+position+' '+preview.toString('base64'));
      }
      assert.deepEqual([...seen].sort((a,b)=>a-b),[0,1,2,3,4,5],'Every numeric command heading remains reachable beyond the method column');
      await scroll.evaluate((node,left)=>{node.scrollLeft=left;},initial);
      if(!opened)await surface.locator('#pr-command-title').click();
      const after=await surface.evaluate(()=>{const root=document.querySelector('#power-response-demo');return {snapshot:JSON.stringify(root.powerDemo.getSnapshot()),state:root.powerDemo.getState(),rows:document.querySelector('#pr-command-rows').textContent};});
      assert.equal(after.snapshot,before.snapshot);assert.equal(after.rows,before.rows);
      assert.equal(after.state.playing,before.state.playing);assert.equal(after.state.inspectedSource,before.state.inspectedSource);assert.equal(after.state.selectedBus,before.state.selectedBus);
      await checkCommandInspection(surface);
    };
    const inspectLinkEvidence = async surface => {
      const initial=await surface.evaluate(()=>{const root=document.querySelector('#power-response-demo');return {snapshot:JSON.stringify(root.powerDemo.getSnapshot()),state:root.powerDemo.getState(),support:root.powerDemo.getSnapshot().deployedSupport};});
      assert.ok(initial.support,'The receipt fixture uses an actual deployed controller');
      assert.equal(initial.state.playing,false);
      const has=(links,edge)=>links.some(link=>link.from===edge.from&&link.to===edge.to);
      const selected=initial.support.links.find(edge=>edge.from!==edge.to&&!has(initial.support.fixedLinks,edge))||initial.support.links.find(edge=>edge.from!==edge.to);
      const excluded=initial.support.fixedLinks.find(edge=>edge.from!==edge.to&&!has(initial.support.links,edge))||
        {to:selected.to,from:Array.from({length:23},(_,i)=>i+2).find(from=>from!==selected.to&&!has(initial.support.links,{from,to:selected.to}))};
      const local={from:selected.to,to:selected.to};
      for(const [index,edge] of [selected,excluded,local].entries()){
        const cell=surface.locator('#pr-matrix .matrix-cell[data-receiver="'+edge.to+'"][data-source="'+edge.from+'"]');
        if(surface.viewportSize().width<500)await cell.tap();else await cell.click();
        await checkCommandInspection(surface);
        const reading=await surface.evaluate(()=>{
          const root=document.querySelector('#power-response-demo'),snapshot=root.powerDemo.getSnapshot(),state=root.powerDemo.getState(),panel=document.querySelector('#pr-link-receipt');
          return {snapshot,state,evidence:root.powerDemo.getLinkEvidence(),hidden:panel.hidden,data:{...panel.dataset},
            headers:['scalar','online'].map(key=>({key,budget:Number(document.querySelector('#pr-link-receipt-'+key).dataset.budget)})),
            cells:Array.from(panel.querySelectorAll('td')).map(cell=>({key:cell.dataset.controller,measure:cell.dataset.measure,value:cell.dataset.value,text:cell.textContent,
              font:Number.parseFloat(getComputedStyle(cell).fontSize),box:cell.getBoundingClientRect().toJSON()})),
            title:document.querySelector('#pr-link-receipt-title').textContent,
            timing:document.querySelector('#pr-link-receipt-action').textContent,
            groups:Array.from(panel.querySelectorAll('tbody')).map(group=>({label:group.getAttribute('aria-label'),measures:Array.from(group.querySelectorAll('tr[data-measure]')).map(row=>row.dataset.measure)})),
            rowLabels:Array.from(panel.querySelectorAll('tr[data-measure]>th')).map(cell=>cell.textContent),
            actionHeader:{tag:document.querySelector('#pr-link-receipt-action').tagName,scope:document.querySelector('#pr-link-receipt-action').scope,span:document.querySelector('#pr-link-receipt-action').colSpan},
            verticalOrder:['pr-link-receipt-action','pr-link-receipt-note'].map(id=>document.getElementById(id).getBoundingClientRect().top),
            gainTop:panel.querySelector('tr[data-measure="gainNorm"]').getBoundingClientRect().top,
            command:Array.from(document.querySelectorAll('#pr-command-rows tr')).map(row=>({...row.dataset}))};
        });
        assert.equal(reading.hidden,false);assert.equal(reading.evidence.source,edge.from);assert.equal(reading.evidence.receiver,edge.to);
        assert.equal(reading.title,'Source '+edge.from+' → inverter '+edge.to);
        assert.equal(Number(reading.data.action),reading.snapshot.lastSample.t);
        assert.match(reading.timing,/Executed action.*Full issued preview/);
        assert.deepEqual(reading.groups,[{label:'Frozen discovery evidence',measures:['selection','score']},{label:'Executed controller evidence',measures:['gainNorm','sourceKvar','commandKvar']}]);
        assert.deepEqual(reading.rowLabels,['Selected support','Discovery score','Deployed gain','Source (kvar)','Command (kvar)']);
        assert.deepEqual(reading.actionHeader,{tag:'TH',scope:'rowgroup',span:3});
        assert.ok(reading.verticalOrder[0]<reading.gainTop&&reading.gainTop<reading.verticalOrder[1],'Actual execution time introduces only the executed controller rows');
        const receiver=[5,7,8,12,14,18,21,24].indexOf(edge.to),column=edge.from-2;
        for(const row of reading.evidence.rows){
          const support=reading.snapshot.deployedSupport,links=row.key==='scalar'?support.fixedLinks:support.links;
          const scores=row.key==='scalar'?support.discoveryDiagnostics.baselineScores:support.discoveryDiagnostics.learnedScores;
          assert.equal(row.selection,edge.from===edge.to?'Local':has(links,edge)?'Selected':'Excluded');
          assert.equal(row.score,scores[receiver][column]);assert.equal(row.budget,24);
          const command=reading.command.find(command=>command.controller===row.key);
          assert.equal(row.gainNorm,Number(command.gainNorm));assert.equal(row.sourceKvar,Number(command.sourceKvar));
          assert.equal(row.commandKvar,reading.snapshot.commandQ[row.key][edge.to-1]);
          for(const measure of ['selection','score','gainNorm','sourceKvar','commandKvar']){
            const cell=reading.cells.find(cell=>cell.key===row.key&&cell.measure===measure);
            assert.equal(cell.value,String(row[measure]));assert.ok(cell.font>=12);
            assert.ok(cell.box.x>=0&&cell.box.right<=surface.viewportSize().width+1,'Receipt stays in viewport');
            assert.notEqual(cell.text,'—');
          }
        }
        assert.deepEqual(reading.headers.map(header=>header.budget),[24,24]);
        assert.equal(JSON.stringify(reading.snapshot),initial.snapshot,'Inspection does not change the physical trial, costs, forecasts or support');
        if(index===0){
          await inspectCommandNavigation(surface);
          await surface.locator('#pr-forecast-observation').screenshot({path:path.join(output,'link-evidence-'+surface.viewportSize().width+'.png')});
          const preview=await surface.locator('#pr-forecast-observation').screenshot({type:'jpeg',quality:85,path:path.join(output,'link-evidence-'+surface.viewportSize().width+'.jpg')});
          console.log('CLOUD_LINK_PREVIEW_'+surface.viewportSize().width+' '+preview.toString('base64'));
        }
      }
      if(initial.state.inspectedSource!==null)await surface.locator('#pr-matrix .matrix-cell[data-receiver="'+initial.state.selectedBus+'"][data-source="'+initial.state.inspectedSource+'"]').click();
      else {await selectSetting(surface,'bus','2');await selectSetting(surface,'bus',String(initial.state.selectedBus));}
      assert.equal(await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),initial.snapshot);
    };
    const checkProtocol = async surface => {
      const reading=await surface.evaluate(()=>{
        const root=document.querySelector('#power-response-demo'),snapshot=root.powerDemo.getSnapshot(),state=root.powerDemo.getState();
        const phase=document.querySelector('#pr-phase');
        return {snapshot:{phase:snapshot.phase,experiment:snapshot.experiment,t:snapshot.t,discoveryRecord:snapshot.discoveryRecord?{t:snapshot.discoveryRecord.t}:null},state,data:{...phase.dataset},badge:phase.textContent,note:document.querySelector('#pr-phase-note').textContent,
          title:document.querySelector('#pr-matrix-title').textContent,headingData:{...document.querySelector('#pr-matrix-title').dataset},headingNote:document.querySelector('#pr-matrix-title').title,
          budget:document.querySelector('#pr-link-budget').textContent,matrixName:document.querySelector('#pr-matrix').getAttribute('aria-label'),
          captionController:document.querySelector('#pr-network-inspection').dataset.controller,
          inspected:state.inspectedSource!==null&&[5,7,8,12,14,18,21,24].includes(state.selectedBus)};
      });
      const {snapshot,state,data}=reading,deployed=snapshot.phase==='deployment',saved=state.historyIndex!==null;
      assert.equal(data.phase,snapshot.phase);
      assert.equal(data.view,saved?'saved-discovery':deployed?'comparison':'discovery');
      assert.equal(Number(data.discoverySamples),deployed?snapshot.discoveryRecord.t:snapshot.t);
      assert.equal(Number(data.comparisonSamples),deployed?snapshot.t:0);
      assert.equal(data.selection,deployed?(snapshot.experiment==='communication'?'complete':'not-applicable'):'pending');assert.equal(data.synthesis,deployed?'complete':'pending');
      assert.equal(data.links,deployed?'fixed':'candidates');
      assert.equal(data.predictionWeights,deployed&&snapshot.experiment==='communication'?'fixed':'adaptive');
      if(saved){
        assert.match(reading.note,/Saved links at .* · Trial continues in/);
        assert.ok(reading.headingNote.startsWith('Saved discovery links at '+data.historyAt+' s'));
        assert.ok(reading.budget.startsWith('Saved at '+data.historyAt+' s · '));
      }else if(deployed)assert.match(reading.note,snapshot.experiment==='communication'?/Sparse comparison.*learning samples.*Fixed links and gains/:/Fresh dense comparison · Updates restart at 30 s/);
      else {assert.match(reading.badge,/Learning/);assert.match(reading.note,/Discovery · Dense messages/);}
      const controller=!saved&&deployed&&snapshot.experiment==='communication'?'Learned sparse':'Online SLS';
      assert.equal(reading.title,controller+' links');assert.equal(reading.headingData.controller,controller);
      assert.equal(reading.headingData.context,data.view);assert.ok(reading.matrixName.startsWith(controller+' · '));
      assert.match(reading.headingNote,/Other controllers use their own prediction sources/);
      if(!saved)assert.ok(reading.budget.startsWith(deployed?'Deployed · ':'Candidate · '));
      if(reading.inspected)assert.equal(reading.captionController,controller);
      return reading;
    };

    const captureLinkOwner = async (surface,label) => {
      await checkProtocol(surface);await checkMatrixGeometry(surface);
      const before=await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot()));
      const preview=await surface.locator('.pr-matrix-panel').screenshot({path:path.join(output,'link-owner-'+label+'.jpg'),type:'jpeg',quality:85});
      console.log('CLOUD_OWNER_PREVIEW_'+label+' '+preview.toString('base64'));
      assert.equal(await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),before,'Reading link ownership changes no trial');
    };

    const checkEventMarkers = async surface => {
      const result=await surface.evaluate(()=>{
        const snapshot=document.querySelector('#power-response-demo').powerDemo.getSnapshot();
        return {snapshot:{t:snapshot.t,eventLog:snapshot.eventLog},charts:['pr-cost','pr-stage','pr-voltage'].map(id=>{
          const svg=document.getElementById(id),frame=svg.querySelector('[data-chart-frame]');
          return {id,hidden:svg.hidden||svg.style.display==='none',frame:frame?{x:Number(frame.getAttribute('x')),w:Number(frame.getAttribute('width'))}:null,
            badges:Array.from(svg.querySelectorAll('.intervention-badge')).map(node=>({data:{...node.dataset},label:node.getAttribute('aria-label'),title:node.querySelector('title').textContent,
              text:node.querySelector('text').textContent,hiddenFromAT:node.getAttribute('aria-hidden'),visible:!Array.from(node.querySelectorAll('rect,path,text')).some(child=>getComputedStyle(child).display==='none')})),
            markerDetails:Array.from(svg.querySelectorAll('.intervention-markers rect')).map(node=>({role:node.getAttribute('role'),label:node.getAttribute('aria-label'),title:node.querySelector('title')?.textContent})),
            lines:Array.from(svg.querySelectorAll('.intervention-markers line')).map(node=>({x1:Number(node.getAttribute('x1')),x2:Number(node.getAttribute('x2'))}))};
        })};
      });
      const snapshot=result.snapshot;
      for(const chart of result.charts.filter(chart=>!chart.hidden)){
        const domain=[chart.id==='pr-cost'?0:Math.max(0,snapshot.t-80),Math.max(1,snapshot.t)];
        const expected=snapshot.eventLog.map((event,order)=>({...event,order,type:event.type==='fault'?'forecast':event.type}))
          .filter(event=>['forecast','pulse','scenario'].includes(event.type)&&(event.type==='forecast'?event.t<=snapshot.t:event.t<snapshot.t))
          .map(event=>({...event,at:event.t+(event.type==='forecast'?0:1)}))
          .filter(event=>event.at>=domain[0]&&event.at<=domain[1]).sort((a,b)=>a.at-b.at||a.order-b.order);
        const times=chart.badges.flatMap(badge=>badge.data.eventSteps.split(',').map(Number));
        const types=chart.badges.flatMap(badge=>badge.data.eventTypes.split(','));
        assert.deepEqual(times,expected.map(event=>event.at),'Markers use actual setting time or first physical state time');
        assert.deepEqual(types,expected.map(event=>event.type),'No mixed events are relabeled as forecasts');
        assert.equal(chart.lines.length,chart.badges.length);
        assert.equal(chart.markerDetails.length,chart.badges.length,'Every actual event group retains its marker and hover details');
        let eventOffset=0,scheduledLabelShown=false;
        for(let i=0;i<chart.badges.length;i++){
          const {data}=chart.badges[i],kinds=data.eventTypes.split(',');
          const events=expected.slice(eventOffset,eventOffset+Number(data.eventCount));eventOffset+=Number(data.eventCount);
          const scheduledOnly=events.every(event=>event.type==='scenario'&&event.forecasted),visible=!scheduledOnly||!scheduledLabelShown;
          if(scheduledOnly)scheduledLabelShown=true;
          assert.equal(data.scheduledOnly,String(scheduledOnly),'Only groups of forecasted scheduled events qualify for label compaction');
          assert.equal(data.labelVisible,String(visible),'Only repeated pure scheduled cycle labels are suppressed');
          assert.equal(chart.badges[i].visible,visible,'Actual SVG glyph visibility follows the measured event group');
          assert.equal(chart.badges[i].hiddenFromAT,'true','Decorative badges do not duplicate the marker event description');assert.equal(chart.markerDetails[i].role,'img');
          assert.equal(chart.markerDetails[i].label,chart.badges[i].label);assert.ok(chart.badges[i].title.includes(chart.markerDetails[i].title),'Every retained marker keeps its original complete detail in its badge tooltip');
          if(scheduledOnly&&visible){
            const scheduled=chart.badges.map((badge,index)=>({badge,index})).filter(({badge})=>badge.data.scheduledOnly==='true');
            const count=scheduled.reduce((total,{badge})=>total+Number(badge.data.scenarioCount),0);
            assert.equal(chart.badges[i].text,count>1?'Scheduled ×'+count:'Scheduled cycle','The single label reports actual scheduled cycles, not plot activity');
            for(const {index} of scheduled)assert.ok(chart.badges[i].title.includes(chart.markerDetails[index].title),'Visible cycle badge tooltip retains every measured cycle detail despite the chart hover layer');
          }
          assert.equal(Number(data.disturbanceCount),kinds.filter(type=>type==='pulse').length);
          assert.equal(Number(data.forecastCount),kinds.filter(type=>type==='forecast').length);
          assert.equal(Number(data.scenarioCount),kinds.filter(type=>type==='scenario').length);
          const at=Number(data.eventSteps.split(',')[0]),x=chart.frame.x+2+(at-domain[0])/(domain[1]-domain[0])*(chart.frame.w-4);
          assert.ok(Math.abs(chart.lines[i].x1-x)<1e-7,'Marker geometry uses the current chart scale immediately');
          assert.equal(chart.lines[i].x1,chart.lines[i].x2);
        }
      }
    };

    const readPowerAttacks = async surface => surface.evaluate(() => {
      const root=document.querySelector('#power-response-demo'),snapshot=root.powerDemo.getSnapshot();
      return {t:snapshot.t,phase:snapshot.phase,selected:root.powerDemo.getState().selectedBus,
        visibleBadges:Array.from(document.querySelectorAll('#pr-network .pe-attack-badge')).filter(node=>getComputedStyle(node).display!=='none').map(node=>Number(node.closest('[data-bus]').dataset.bus)),
        marked:Array.from(document.querySelectorAll('#pr-network [data-bus]')).filter(node=>node.querySelector('.pe-attacked')).map(node=>Number(node.dataset.bus)),
        counts:Object.fromEntries([20,22,23].map(bus=>[bus,snapshot.eventLog.filter(event=>event.type==='pulse'&&event.bus===bus).length])),
        active:Array.from(document.querySelectorAll('#pr-network [data-bus]')).filter(node=>node.getAttribute('aria-label')==='Stop attack at bus '+node.dataset.bus).map(node=>Number(node.dataset.bus)).sort((a,b)=>a-b),
        applied:snapshot.lastPulseApplications.map(item=>({bus:item.bus,requestedKw:item.requestedKw,appliedKw:item.appliedKw})),
        targetKw:Number(document.querySelector('#pr-strength').value),continuousComponents:snapshot.activePulses.filter(item=>item.protocol==='held-target-v1').map(item=>item.bus),
        minimumVoltage:Object.fromEntries(Object.entries(snapshot.voltages).map(([key,values])=>[key,Math.min(...values)])),
        cumulative:{...snapshot.cumulative}};
    });
    const checkPowerAttacks = async (surface,buses) => {
      const reading=await readPowerAttacks(surface);
      assert.deepEqual(reading.active,buses,'Each latched bus has its own visible stop action');
      assert.equal(await surface.locator('#pr-attack-count').textContent(),String(buses.length));
      assert.equal(await surface.locator('#pr-stop-attacks').isVisible(),buses.length>0);
      assert.deepEqual(reading.visibleBadges,[reading.selected],'Only the inspected disturbed bus shows the full power badge');
      for(const bus of buses) {
        assert.ok(reading.marked.includes(bus),'Other active buses retain their orange attack marking');
        assert.ok(reading.counts[bus]>0,'Bus '+bus+' has actual queued attack events');
        assert.ok(reading.applied.some(item=>item.bus===bus&&item.appliedKw>0),'Bus '+bus+' has a measured power disturbance');
        assert.equal(reading.applied.find(item=>item.bus===bus).requestedKw,reading.targetKw,'Continuous bus '+bus+' maintains the selected requested kW without stacking');
        assert.equal(reading.continuousComponents.filter(item=>item===bus).length,1,'Exactly one continuous component per bus');
      }
      return reading;
    };

    const checkPlots = async () => {
      await checkExperimentProgress(page);
      await checkEventMarkers(page);
      await checkVoltageMetrics(page);
      await checkProtocol(page);
      await checkForecastObservation(page);
      await checkSourceHistory(page);
      await checkCommandInspection(page);
      for (const chart of ['pr-cost', 'pr-stage', 'pr-voltage']) {
        const paths = await page.locator(`#${chart} path.data-series`).evaluateAll(elements => elements.map(element => element.getAttribute('d')));
        assert.equal(paths.length, 4, `${chart} retains all four controller curves`);
        assert.ok(paths.every(value => value && !/NaN|Infinity/.test(value)), `${chart} has finite measured paths`);
        assert.ok(await page.locator(`#${chart} .y-axis .tick`).count() < 12, `${chart} does not accumulate axis labels`);
      }
    };

    const checkExperimentProgress = async surface => {
      const reading=await surface.evaluate(()=>{
        const snapshot=document.querySelector('#power-response-demo').powerDemo.getSnapshot(),section=document.querySelector('#pr-experiment-progress');
        return {phase:snapshot.phase,experiment:snapshot.experiment,costs:snapshot.cumulative,support:snapshot.deployedSupport,
          hidden:section.hidden,phaseHidden:document.querySelector('#pr-phase').hidden,
          discoverySamples:snapshot.discoveryRecord?.t,t:snapshot.t,
          title:document.querySelector('#pr-learning-title').textContent,subtitle:document.querySelector('#pr-results-stage').textContent,
          note:document.querySelector('#pr-transition-note').textContent,
          order:!!(document.querySelector('.pr-controlbar').compareDocumentPosition(section)&Node.DOCUMENT_POSITION_FOLLOWING),
          interactive:section.querySelectorAll('button,a,input,select,[role="button"]').length,
          steps:['learning','comparison'].map(name=>{
            const item=document.querySelector('#pr-progress-'+name),count=document.querySelector('#pr-progress-'+name+'-count');
            return {name,status:item.dataset.status,current:item.getAttribute('aria-current'),count:count.textContent,
              boxes:[item,count].map(cell=>({font:parseFloat(getComputedStyle(cell).fontSize),...cell.getBoundingClientRect().toJSON()}))};
          }),
          rows:Array.from(document.querySelectorAll('#pr-cost-detail tr')).map(row=>{
            const links=row.querySelector('.pr-method-links'),cost=row.querySelector('[data-cost]');
            return {key:row.dataset.method,links:links?Number(links.dataset.links):null,linkText:links?.textContent,
              cost:cost?Number(cost.dataset.cost):null,cells:row.querySelectorAll('th,td').length,
              boxes:Array.from(row.querySelectorAll('th,td,.pr-method-links')).map(cell=>({tag:cell.tagName,font:parseFloat(getComputedStyle(cell).fontSize),...cell.getBoundingClientRect().toJSON()}))};
          })};
      });
      const communication=reading.experiment==='communication',deployed=reading.phase==='deployment';
      assert.equal(reading.hidden,!communication,'Only communication topology has this fixed comparison protocol');
      assert.equal(reading.phaseHidden,communication,'The main controls do not duplicate the progress stage');
      if(!communication)return reading;
      assert.equal(reading.title,'Experiment results','The same results panel keeps its identity across the reset');
      assert.equal(reading.order,true,'The explanation follows the controls rather than hiding in settings');
      assert.equal(reading.interactive,0,'The stage indicator adds no required action');
      assert.match(reading.note,/fresh/i);
      assert.match(reading.note,deployed?/Learning costs excluded/i:/fresh trial/i);
      assert.equal(reading.steps[0].status,deployed?'complete':'active');
      assert.equal(reading.steps[0].current,deployed?null:'step');
      assert.equal(Number(reading.steps[0].count.match(/^\d+/)?.[0]),deployed?reading.discoverySamples:reading.t);
      if(deployed)assert.equal(Number(reading.steps[1].count.match(/^\d+/)?.[0]),reading.t);
      else assert.equal(reading.steps[1].count,'Next');
      assert.ok(deployed?['active','complete'].includes(reading.steps[1].status):reading.steps[1].status==='pending');
      assert.equal(reading.steps[1].current,deployed?'step':null);
      if(deployed)assert.match(reading.note,/fixed/i);
      for(const item of reading.steps)for(const box of item.boxes){
        assert.ok(box.font>=12,'Visible phase counts remain readable');
        assert.ok(box.left>=-1&&box.right<=surface.viewportSize().width+1,'Persistent phase text fits the viewport');
      }
      if(!deployed){
        assert.ok(reading.rows.every(row=>row.links===null),'Candidate counts cannot be mistaken for deployed message budgets');
        return reading;
      }
      assert.equal(reading.subtitle,'Controller comparison');
      assert.deepEqual(reading.rows.map(row=>row.key),['online','scalar','static','causal'],'All four measured methods retain their existing cost rows');
      const expected={online:reading.support.links.filter(link=>link.from!==link.to).length,
        scalar:reading.support.fixedLinks.filter(link=>link.from!==link.to).length,static:176,causal:0};
      for(const row of reading.rows){
        assert.equal(row.links,expected[row.key],'The existing cost row shows actual remote support');
        assert.equal(row.linkText,expected[row.key]+' remote links');
        assert.equal(row.cost,reading.costs[row.key],'The same row retains exact cumulative stage cost');
        assert.equal(row.cells,3,'Remote counts do not add a fourth narrow numeric column');
        for(const box of row.boxes){
          assert.ok(box.font>=12,'Method budgets remain readable');
          assert.ok(box.left>=-1&&box.right<=surface.viewportSize().width+1,'Cost cells and budgets fit the viewport');
        }
        const cells=row.boxes.filter(box=>box.tag==='TH'||box.tag==='TD');
        assert.ok(cells.every((box,index)=>!index||box.left>=cells[index-1].right-1),'Cost columns do not overlap');
      }
      return reading;
    };

    const captureExperimentProgress = async surface => {
      const width=surface.viewportSize().width;
      await surface.locator('#pr-experiment-progress').screenshot({path:path.join(output,'experiment-progress-'+width+'.png')});
      const section=surface.locator('.pr-learning-panel');
      await section.screenshot({path:path.join(output,'comparison-budgets-'+width+'.png')});
      const preview=await section.screenshot({path:path.join(output,'comparison-budgets-'+width+'.jpg'),type:'jpeg',quality:85});
      console.log('CLOUD_PROGRESS_PREVIEW_'+width+' '+preview.toString('base64'));
    };
    const checkValidationReport = async surface => {
      const panel=surface.locator('#pr-reference-study');
      const before=await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot()));
      await checkRemovedInterface(surface);
      const measured=await panel.evaluate(element=>({
        text:element.textContent,notes:Array.from(element.querySelectorAll('[title]')).map(node=>node.title).join(' '),
        links:Array.from(element.querySelectorAll('a')).map(a=>a.getAttribute('href')),
        legacyNumbers:element.querySelectorAll('[data-study-method],[data-regime-method],[data-ablation-method],[data-beta]').length
      }));
      assert.equal(measured.legacyNumbers,0,'Old benchmark points must not be attributed to the new controller');
      assert.match(measured.notes,/upstream benchmark tables describe a different implementation/i);
      assert.match(measured.notes,/not displayed as evidence/);
      assert.match(measured.text,/Plots: accumulated stage cost/);
      assert.match(measured.text,/Validation: terminal cost reported separately/);
      assert.deepEqual(measured.links,['environment.html','validation-report.json','README.md']);
      const report=JSON.parse(await fs.readFile(path.join(root,'validation-report.json'),'utf8'));
      assert.equal(report.status,'passed');assert.equal(report.failures.length,0);
      for(const source of ['src/online-predsls.js','src/simulation.js','src/response-controller.js'])assert.match(report.sources[source],/^[a-f0-9]{64}$/);
      assert.equal(await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),before,'Reading retained validation evidence leaves the run intact');
    };

    const checkCostSwitch = async (surface,metric,reference) => {
      const reading=await surface.evaluate(()=>{
        const input=document.querySelector('#pr-cost-metric'),chart=document.querySelector('#pr-cost');
        const zero=chart.querySelector('line.cost-reference'),baseline=chart.querySelector('path.data-series[data-series-key="scalar"]');
        return {value:input.value,hidden:input.hidden,type:input.type,
          buttons:['total','gap'].map(key=>({key,pressed:document.querySelector('#pr-cost-'+key).getAttribute('aria-pressed')})),
          label:chart.getAttribute('aria-label'),gapLabel:document.querySelector('#pr-cost-gap').getAttribute('aria-label'),
          note:document.querySelector('#pr-cost-note').textContent,
          paths:Array.from(chart.querySelectorAll('path.data-series')).map(node=>({key:node.dataset.seriesKey,d:node.getAttribute('d')})),
          zeroY:zero?Number(zero.getAttribute('y1')):null,baseline:baseline?.getAttribute('d')};
      });
      assert.equal(reading.value,metric);assert.equal(reading.hidden,true);assert.equal(reading.type,'hidden');
      for(const button of reading.buttons)assert.equal(button.pressed,String(button.key===metric));
      assert.equal(reading.gapLabel,'Difference from '+reference);
      assert.deepEqual(reading.paths.map(item=>item.key).sort(),['causal','online','scalar','static']);
      assert.ok(reading.paths.every(item=>item.d&&!/NaN|Infinity/.test(item.d)),'Both quantities retain all four finite curves');
      if(metric==='gap'){
        assert.ok(reading.label.includes('difference from '+reference));
        assert.match(reading.label,/Zero is the reference/);assert.ok(reading.note.startsWith('Compared with '+reference+' · Below zero is cheaper'));
        assert.ok(Number.isFinite(reading.zeroY),'Difference shows its zero reference');
        const coordinates=Array.from(reading.baseline.matchAll(/[ML]([^,]+),([^MLZ]+)/g),match=>Number(match[2]));
        assert.ok(coordinates.length>0&&coordinates.every(value=>Math.abs(value-reading.zeroY)<.001),'The fixed or scalar baseline is exactly zero at every plotted sample');
      }else{assert.match(reading.label,/Cumulative cost of 4/);assert.equal(reading.zeroY,null);}
    };

    const checkKeyboardInspection = async () => {
      const before=await page.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot()));
      let receiver=5,source=7;
      const current=()=>page.locator('#pr-matrix .matrix-cell[data-receiver="'+receiver+'"][data-source="'+source+'"]');
      await current().focus();
      for(const [key,nextReceiver,nextSource] of [['Enter',5,7],['ArrowRight',5,8],['ArrowDown',7,8],['Home',7,2],['End',7,24],['ArrowUp',5,24],[' ',5,24]]) {
        await current().press(key===' '?'Space':key);receiver=nextReceiver;source=nextSource;
        const reading=await page.evaluate(()=>{
          const root=document.querySelector('#power-response-demo');
          return {state:root.powerDemo.getState(),snapshot:JSON.stringify(root.powerDemo.getSnapshot()),
            focused:{source:document.activeElement.dataset.source,receiver:document.activeElement.dataset.receiver}};
        });
        assert.equal(reading.state.selectedBus,receiver);assert.equal(reading.state.inspectedSource,source);
        assert.equal(reading.state.playing,false);assert.equal(reading.snapshot,before,'Keyboard inspection cannot change the experiment');
        assert.equal(reading.focused.source,String(source));assert.equal(reading.focused.receiver,String(receiver));
        const connected=await current().getAttribute('data-connected')==='true';
        const inspectedPaths=await page.locator('#pr-network .recommended path[data-inspected="true"]').evaluateAll(nodes=>nodes.map(node=>({from:node.dataset.from,to:node.dataset.to,change:node.dataset.change})));
        assert.equal(inspectedPaths.length,connected&&receiver!==source?1:0,'Current keyboard inspection '+JSON.stringify({key,receiver,source,connected,inspectedPaths}));
        assert.equal(await page.locator('#pr-matrix .matrix-cell[tabindex="0"]').count(),1,'Exactly one matrix cell is in the tab sequence');
      }
      // Native disclosure activation must not trigger the global playback shortcut.
      const title=page.locator('#pr-command-title'),open=await page.locator('#pr-command-inspector').getAttribute('open');
      await title.focus();await title.press('Space');
      assert.equal(await page.locator('#pr-command-inspector').getAttribute('open'),open===null?'':null);
      assert.equal(await page.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getState().playing),false);
      await title.press('Space');await checkCommandInspection(page);
    };

    const inspectLinks = async () => {
      const before = await page.evaluate(() => JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot()));
      const edge = await page.locator('#pr-matrix .matrix-cell[data-connected="true"]').evaluateAll(cells => {
        const cell=cells.find(cell=>cell.dataset.receiver!==cell.dataset.source);
        return {receiver:Number(cell.dataset.receiver),source:Number(cell.dataset.source)};
      });
      const inspect = async (source,connected,local=false) => {
        await page.locator('#pr-matrix .matrix-cell[data-receiver="'+edge.receiver+'"][data-source="'+source+'"]').click();
        const reading=await page.evaluate(() => {
          const root=document.querySelector('#power-response-demo');
          return {state:root.powerDemo.getState(),snapshot:JSON.stringify(root.powerDemo.getSnapshot())};
        });
        await checkForecastObservation(page);
      await checkSourceHistory(page);
      await checkCommandInspection(page);
        assert.equal(reading.snapshot,before,'Inspection changes no physical, forecast or control state');
        assert.equal(reading.state.selectedBus,edge.receiver);
        assert.equal(reading.state.inspectedSource,source);
        assert.equal(reading.state.playing,false);
        assert.equal(await page.locator('#pr-network [data-bus="'+source+'"]').getAttribute('data-inspection-role'),local?'local':'source');
        if(!local) assert.equal(await page.locator('#pr-network [data-bus="'+edge.receiver+'"]').getAttribute('data-inspection-role'),'receiver');
        const arcs=page.locator('#pr-network .recommended path[data-inspected="true"]');
        assert.equal(await arcs.count(),connected&&!local?1:0,'Highlight only the actual remote connection');
        if(connected&&!local) {
          assert.equal(await arcs.getAttribute('data-from'),String(source));
          assert.equal(await arcs.getAttribute('data-to'),String(edge.receiver));
          assert.notEqual(await arcs.getAttribute('data-change'),'removed');
        }
        assert.match(await page.locator('#pr-network').getAttribute('aria-description'),local?/Local source/:connected?/Selected link/:/No link/);
      };
      await inspect(edge.source,true);
      const absent=await page.locator('#pr-matrix .matrix-cell[data-receiver="'+edge.receiver+'"][data-connected="false"]').first().getAttribute('data-source');
      await inspect(Number(absent),false);
      await inspect(edge.receiver,true,true);
      await inspect(edge.source,true);
      await captureNetworkInspection(page);
      const sourceState=async()=>page.evaluate(()=>{
        const root=document.querySelector('#power-response-demo'),snapshot=root.powerDemo.getSnapshot(),state=root.powerDemo.getState();
        return {faults:snapshot.faults,state:{selectedBus:state.selectedBus,inspectedSource:state.inspectedSource,playing:state.playing},
          unchanged:JSON.stringify({t:snapshot.t,phase:snapshot.phase,states:snapshot.states,cumulative:snapshot.cumulative,
            support:snapshot.deployedSupport,lastInputs:snapshot.lastInputs,pending:snapshot.pendingPulses,active:snapshot.activePulses,recommendations:snapshot.recommendations})};
      });
      const initial=await sourceState();
      for(let i=0;i<2;i++) {
        const prior=await sourceState(),wasNoisy=prior.faults.includes(edge.source);
        assert.equal(await page.locator('#pr-source-fault').getAttribute('aria-label'),(wasNoisy?'Repair':'Corrupt')+' forecast source at bus '+edge.source);
        await page.locator('#pr-source-fault').click();
        const after=await sourceState();
        await checkEventMarkers(page);
        await checkForecastObservation(page);
      await checkSourceHistory(page);
      await checkCommandInspection(page);
        assert.equal(after.faults.includes(edge.source),!wasNoisy,'Each explicit action toggles once');
        assert.deepEqual(after.faults.filter(bus=>bus!==edge.source),initial.faults.filter(bus=>bus!==edge.source),'Only inspected source changes');
        assert.deepEqual(after.state,initial.state,'Receiver, source selection and pause state remain unchanged');
        assert.equal(after.unchanged,initial.unchanged,'Reliability actions do not rewrite controls, state, costs or topology');
      }
      assert.deepEqual((await sourceState()).faults,initial.faults,'Second action repairs or corrupts back to initial state');
    };
    // The shipped default is a complete application scenario, not an optional knob.
    const initialDefault=await page.evaluate(()=>{
      const root=document.querySelector('#power-response-demo'),snapshot=root.powerDemo.getSnapshot();
      return {scenario:snapshot.powerScenario,beta:snapshot.beta,phase:snapshot.phase,t:snapshot.t};
    });
    assert.deepEqual(initialDefault,{scenario:'forecasted-demand',beta:4,phase:'discovery',t:0});
    assert.equal(await page.locator('#pr-new-scenario').isVisible(),false);
    assert.match(await page.locator('#pr-scenario-description').getAttribute('title'),/compare four controllers automatically/);
    await captureForecastSettings(page);
    await checkControllerKey(page,true);
    await checkExperimentProgress(page);
    await page.evaluate(()=>{
      const root=document.querySelector('#power-response-demo'),progress=document.querySelector('#pr-experiment-progress');
      const observer=new MutationObserver(()=>{
        if(progress.dataset.phase!=='deployment')return;
        const snapshot=root.powerDemo.getSnapshot();
        window.__experimentHandoff={t:snapshot.t,playing:root.powerDemo.getState().playing,costs:snapshot.cumulative,
          title:document.querySelector('#pr-learning-title').textContent,
          subtitle:document.querySelector('#pr-results-stage').textContent,
          note:document.querySelector('#pr-transition-note').textContent,
          learning:document.querySelector('#pr-progress-learning').dataset.status,
          comparison:document.querySelector('#pr-progress-comparison').dataset.status};
        observer.disconnect();
      });
      observer.observe(progress,{attributes:true,attributeFilter:['data-phase']});
    });
    await page.locator('#pr-run').click();
    await page.waitForFunction(()=>document.querySelector('#power-response-demo').powerDemo.getState().comparisonComplete,null,{timeout:45000});
    const handoff=await page.evaluate(()=>window.__experimentHandoff);
    assert.ok(handoff,'The persistent strip identifies the actual automatic handoff');
    assert.equal(handoff.t,0);assert.equal(handoff.playing,true,'Comparison starts without an extra click or pause');
    assert.ok(Object.values(handoff.costs).every(cost=>cost===0),'Comparison begins with fresh costs');
    assert.equal(handoff.title,'Experiment results');assert.equal(handoff.subtitle,'Controller comparison');
    assert.equal(handoff.learning,'complete');assert.equal(handoff.comparison,'active');
    assert.match(handoff.note,/fresh/i);assert.match(handoff.note,/Learning costs excluded/i);assert.match(handoff.note,/fixed/i);
    const reviewed=await page.evaluate(()=>{
      const root=document.querySelector('#power-response-demo'),snapshot=root.powerDemo.getSnapshot();
      return {phase:snapshot.phase,t:snapshot.t,state:root.powerDemo.getState(),costs:snapshot.cumulative,
        scheduled:snapshot.lastScenarioApplications,events:snapshot.eventLog,
        rendered:Array.from(document.querySelectorAll('#pr-network [data-bus]')).map(node=>({bus:Number(node.dataset.bus),kw:Number(node.dataset.scheduledKw)}))};
    });
    assert.equal(reviewed.phase,'deployment');assert.equal(reviewed.t,180);assert.equal(reviewed.state.playing,false);
    assert.equal(reviewed.events.some(event=>event.type==='pulse'),false);
    assert.ok(reviewed.events.some(event=>event.type==='scenario'&&event.forecasted));
    for(const item of reviewed.scheduled)assert.ok(Math.abs(reviewed.rendered.find(node=>node.bus===item.bus).kw-item.appliedKw)<1e-9,'The scene uses actual scheduled power');
    assert.equal(await page.locator('#pr-run').textContent(),'Continue');
    assert.equal(await page.locator('#pr-cost-detail tr').count(),4);
    for(const chart of ['pr-cost','pr-stage','pr-voltage'])assert.equal(await page.locator('#'+chart+' path.data-series').count(),4);
    await checkEventMarkers(page);await checkVoltageMetrics(page);
    await checkExperimentProgress(page);
    await checkControllerKey(page,true);
    const designsBefore=await page.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot()));
    for(const key of ['online','scalar','static'])await page.locator('[data-series="'+key+'"]').click();
    await checkExperimentProgress(page);
    assert.equal(await page.locator('#pr-cost path.data-series').count(),1,'Curve visibility is independent from the four measured method budgets');
    for(const key of ['online','scalar','static'])await page.locator('[data-series="'+key+'"]').click();
    assert.equal(await page.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),designsBefore,'Comparative design inspection cannot alter the run');
    await checkValidationReport(page);
    await inspectLinkEvidence(page);
    assert.ok((await page.locator('.intervention-badge title').allTextContents()).filter(text=>text.includes('Scheduled demand')).every(text=>text.includes('Included in issued forecasts')));
    await page.screenshot({path:path.join(output,'default-scenario-complete.png'),fullPage:true});
    await page.locator('#pr-experiment-progress').screenshot({path:path.join(output,'experiment-complete-desktop.png')});
    await captureExperimentProgress(page);
    await captureDashboard(page);
    await exerciseDashboardLayout(page);
    await page.locator('.pr-learning-panel').screenshot({path:path.join(output,'default-scenario-costs.png')});
    await fs.writeFile(path.join(output,'default-scenario.json'),JSON.stringify(reviewed,null,2));
    // Completed results stay reviewed while source settings are edited in place.
    await page.locator('#pr-matrix .matrix-cell[data-receiver="5"][data-source="7"]').click();
    const boundary=async()=>page.evaluate(()=>{
      const root=document.querySelector('#power-response-demo'),snapshot=root.powerDemo.getSnapshot(),state=root.powerDemo.getState();
      return {t:snapshot.t,horizon:snapshot.horizon,mode:snapshot.mode,segments:snapshot.segments,
        states:snapshot.states,costs:snapshot.cumulative,support:snapshot.deployedSupport,lastSample:snapshot.lastSample,
        events:snapshot.eventLog,faults:snapshot.faults,playing:state.playing,complete:state.comparisonComplete,continued:state.comparisonContinued};
    });
    const completedBefore=await boundary();
    for(const noisy of [true,false,true]){
      await page.locator('#pr-source-fault').click();
      const after=await boundary();
      assert.equal(after.faults.includes(7),noisy);
      assert.equal(after.complete,true);assert.equal(after.continued,false);assert.equal(after.playing,false);
      assert.equal(after.t,180);assert.equal(after.mode,'completed');
      for(const key of ['horizon','segments','states','costs','support','lastSample'])assert.deepEqual(after[key],completedBefore[key],'Paused endpoint setting preserves '+key);
      assert.equal(after.events.some(event=>event.type==='extend'),false,'A setting does not implicitly extend the completed trial');
      assert.equal(await page.locator('#pr-run').textContent(),'Continue');
      await checkForecastObservation(page);await checkSourceHistory(page);await checkCommandInspection(page);await checkEventMarkers(page);
      assert.equal(await page.locator('#pr-forecast-change').getAttribute('data-issued'),'false');
      assert.equal(await page.locator('#pr-cost path.data-series').count(),4);
    }
    const beforeVoltageDetails=await page.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot()));
    await page.locator('#pr-voltage-details > summary').click();
    assert.equal(await page.locator('#pr-voltage-metrics').isVisible(),true);
    await checkVoltageMetrics(page);
    assert.equal(await page.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),beforeVoltageDetails,'Opening voltage details does not change the trial');
    await page.locator('#pr-voltage-details > summary').click();
    await page.screenshot({path:path.join(output,'completed-source-settings.png'),fullPage:true});
    await page.reload({waitUntil:'networkidle'});
    assert.equal(await page.locator('#pr-run').textContent(),'Continue');
    assert.equal(await page.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getSnapshot().t),180);
    const completedRestored=await boundary();
    assert.equal(completedRestored.faults.includes(7),true);assert.equal(completedRestored.complete,true);
    assert.equal(completedRestored.continued,false);assert.equal(completedRestored.mode,'completed');
    assert.deepEqual(completedRestored.costs,completedBefore.costs);
    assert.deepEqual(completedRestored.segments,completedBefore.segments);
    await stepSetting(page);assert.equal(await sample(),181);
    await checkExperimentProgress(page);
    await page.getByRole('button',{name:'Restart demo',exact:true}).click();
    const restarted=await page.evaluate(()=>{
      const root=document.querySelector('#power-response-demo');return {snapshot:root.powerDemo.getSnapshot(),state:root.powerDemo.getState()};
    });
    assert.equal(restarted.snapshot.phase,'discovery');assert.equal(restarted.snapshot.t,0);
    assert.equal(restarted.snapshot.powerScenario,'forecasted-demand');assert.equal(restarted.snapshot.beta,4);
    assert.equal(restarted.snapshot.deployedSupport,null);assert.equal(restarted.snapshot.discoveryRecord,null);
    assert.ok(Object.values(restarted.snapshot.cumulative).every(value=>value===0));
    assert.equal(restarted.snapshot.eventLog.length,0);assert.equal(restarted.state.playing,false);
    assert.deepEqual(restarted.state.activeAttackBuses,[]);assert.equal(restarted.state.historyIndex,null);
    assert.equal(await page.locator('#pr-speed').inputValue(),'32');
    assert.equal(await page.locator('#pr-adaptation').getAttribute('open'),null);
    assert.equal(await page.locator('#pr-run').textContent(),'Run');
    await checkExperimentProgress(page);
    await page.screenshot({path:path.join(output,'concise-restarted-desktop.png'),fullPage:true});
    await useReference(page);
    await mark('default scenario completed restored and explicitly continued');
    await mark('loaded');
    await checkKeyboardInspection();
    await inspectLinks();
    await mark('discovery inspection');
    await captureLinkOwner(page,'1440-discovery');
    await checkVoltageMetrics(page);
    await checkProtocol(page);
    await page.locator('#pr-command-title').click();
    assert.equal(await page.locator('#pr-command-inspector').getAttribute('open'),'');

    // Ordinary playback and repeated forecast toggles use the actual bus targets.
    await page.locator('#pr-run').click();
    await waitSamples(3);
    await pause();
    await page.getByRole('button', { name: 'Corrupt forecast at bus 7', exact: true }).click();
    await waitSamples(2);
    await page.getByRole('button', { name: 'Repair forecast at bus 7', exact: true }).click();
    await waitSamples(2);
    await pause();

    // Independent continuous attacks survive discovery and stop one bus at a time.
    await page.locator('#pr-command-title').click();
    await page.locator('#pr-intervention').selectOption('power');
    await selectSetting(page,'strength','150');
    assert.equal(await page.locator('#pr-strength').isVisible(),false);
    assert.match(await page.locator('#pr-attack-hint').textContent(),/^150 kW target per bus · /);
    for(const bus of [20,22,23])await page.getByRole('button',{name:'Toggle continuous attack at bus '+bus,exact:true}).click();
    await waitSamples(3);
    const attacksBefore=await checkPowerAttacks(page,[20,22,23]);
    assert.equal(await page.locator('#pr-pulse').getAttribute('aria-pressed'),'true');
    await waitSamples(3);
    const attacksRepeating=await checkPowerAttacks(page,[20,22,23]);
    for(const bus of [20,22,23])assert.ok(attacksRepeating.counts[bus]>attacksBefore.counts[bus],'Bus '+bus+' repeats while other buses remain active');
    await page.locator('#pr-adaptation > summary').click();
    await page.locator('#pr-compare').click();
    await page.waitForFunction(() => document.querySelector('#pr-phase').dataset.phase === 'deployment' && !document.querySelector('#pr-compare').disabled);
    await waitSamples(3);
    const attacksDeployed=await checkPowerAttacks(page,[20,22,23]);
    assert.equal(attacksDeployed.phase,'deployment');
    assert.equal(await page.locator('#pr-pulse').getAttribute('aria-pressed'),'true');
    await page.locator('#pr-bus').selectOption('20');
    assert.deepEqual((await readPowerAttacks(page)).visibleBadges,[20],'Selection moves the full kW reading without stopping other buses');
    await page.locator('#pr-bus').selectOption('23');
    await page.locator('#pr-adaptation > summary').click();
    await page.screenshot({path:path.join(output,'concurrent-attacks.png'),fullPage:true});
    await page.locator('#pr-adaptation > summary').click();
    await page.getByRole('button',{name:'Stop attack at bus 22',exact:true}).click();
    const stoppedBus=await readPowerAttacks(page);
    // Inspect an active bus. The stopped bus can finish fading during CI playback.
    await page.locator('#pr-bus').selectOption('23');
    await waitSamples(3);
    const attacksAfterStop=await checkPowerAttacks(page,[20,23]);
    assert.equal(attacksAfterStop.counts[22],stoppedBus.counts[22],'Stopping bus 22 adds no further attacks there');
    for(const bus of [20,23])assert.ok(attacksAfterStop.counts[bus]>stoppedBus.counts[bus],'Stopping one bus preserves the other continuous attacks');
    await fs.writeFile(path.join(output,'concurrent-attacks.json'),JSON.stringify({before:attacksBefore,repeating:attacksRepeating,deployed:attacksDeployed,stopped:stoppedBus,afterStop:attacksAfterStop},null,2));
    await page.locator('#pr-bus').selectOption('23');
    await page.locator('#pr-pulse').click();
    assert.equal(await page.locator('#pr-pulse').getAttribute('aria-pressed'),'false');
    assert.deepEqual((await readPowerAttacks(page)).active,[20],'The primary action stops only its selected bus');
    await page.getByRole('button',{name:'Toggle continuous attack at bus 23',exact:true}).click();
    await page.getByRole('button',{name:'Stop all 2 active buses',exact:true}).click();
    const allStopped=await readPowerAttacks(page);
    assert.deepEqual(allStopped.active,[],'Stop all releases every continuous attack');
    assert.equal(await page.locator('#pr-stop-attacks').isVisible(),false);
    await waitSamples(3);
    assert.deepEqual((await readPowerAttacks(page)).counts,allStopped.counts,'Stop all prevents new requests while existing disturbances decay');
    await pause();
    await page.locator('#pr-adaptation > summary').click();
    assert.equal(await page.locator('#pr-cost-detail tr').count(), 4);
    await checkPlots();
    await checkKeyboardInspection();
    await inspectLinks();

    await mark('comparison handoff and inspection');

    // Hiding the archive preserves live response inspection and recorded topology data.
    const liveBefore=await page.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot()));
    assert.ok(Number(await page.locator('#pr-topology-history').getAttribute('max'))>0,'Discovery continues recording link changes');
    await checkRemovedInterface(page);
    assert.equal(await page.locator('#pr-topology-events').isVisible(),false,'Recorded changes remain outside the visible interface');
    assert.equal(await page.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getState().historyIndex),null);
    await checkProtocol(page);
    await selectSetting(page,'matrix-view','change');
    await checkProtocol(page);await checkForecastObservation(page);await checkSourceHistory(page);await checkCommandInspection(page);
    assert.equal(await page.locator('#pr-source-fault').isDisabled(),false,'Live source actions remain available in the weight view');
    assert.ok(await page.locator('#pr-matrix .matrix-columns text[data-noisy="true"]').count()>0,'Source quality remains attached to current links');
    assert.equal(await page.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),liveBefore);
    await selectSetting(page,'matrix-view','links');
    assert.equal(await page.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),liveBefore);

    await mark('live response inspection');

    // Real buttons remain stable across live renders, including a press held over samples.
    assert.equal(await page.locator('#pr-speed').inputValue(),'32');
    assert.equal(await page.locator('#pr-cost-switch').getAttribute('role'),'group');
    await page.locator('#pr-run').click();
    const switchingStart = await sample();
    for (const metric of Array.from({ length: 30 }, (_, index) => index % 2 ? 'total' : 'gap')) {
      await page.locator('#pr-cost-'+metric).click();
      await checkCostSwitch(page,metric,'fixed sparse');
      assert.equal(await page.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getState().playing),true,'Metric changes never pause playback');
      await checkPlots();
    }
    const held=page.locator('#pr-cost-gap');await held.scrollIntoViewIfNeeded();
    await held.evaluate(node=>{window.__heldCostButton=node;});
    const heldBounds=await held.boundingBox();
    await page.mouse.move(heldBounds.x+heldBounds.width/2,heldBounds.y+heldBounds.height/2);
    await page.mouse.down();await waitSamples(3);
    assert.equal(await held.evaluate(node=>node===window.__heldCostButton&&document.activeElement===node),true,'Live samples retain the pressed node and native focus');
    await page.mouse.up();await checkCostSwitch(page,'gap','fixed sparse');
    for(const [metric,key] of [['total','Enter'],['gap','Space']]){
      const button=page.locator('#pr-cost-'+metric);await button.focus();await button.press(key);
      await checkCostSwitch(page,metric,'fixed sparse');
      assert.equal(await page.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getState().playing),true,'Native '+key+' on a quantity button must not toggle playback');
    }
    await mark('thirty live cost button switches plus held pointer and keyboard');
    await waitSamples(2);
    assert.ok(await sample() > switchingStart, 'Playback continues during metric switching');
    await pause();
    await page.locator('.pr-learning-panel').screenshot({path:path.join(output,'cost-switch-difference-desktop.png')});
    const savedMetricSnapshot=await page.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot()));
    await page.reload({waitUntil:'networkidle'});
    await checkCostSwitch(page,'gap','fixed sparse');
    await checkExperimentProgress(page);
    assert.equal(await page.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),savedMetricSnapshot,'Restored gap changes no measured state or cost');
    assert.equal(await page.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getState().playing),false,'Restored gap stays paused');
    await page.locator('#pr-cost-total').click();await checkCostSwitch(page,'total','fixed sparse');
    await page.locator('.pr-learning-panel').screenshot({path:path.join(output,'cost-switch-total-desktop.png')});
    await page.locator('#pr-adaptation > summary').click();
    await page.locator('#pr-power-scenario').selectOption('solar-outage');
    await page.locator('#pr-compare').click();
    await page.waitForFunction(()=>document.querySelector('#pr-phase').dataset.phase==='deployment'&&!document.querySelector('#pr-compare').disabled);
    await page.locator('#pr-adaptation > summary').click();
    await page.locator('#pr-run').click();
    await page.waitForFunction(()=>document.querySelector('#power-response-demo').powerDemo.getSnapshot().scenario.active);
    await pause();
    const outage=await page.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getSnapshot());
    assert.equal(outage.powerScenario,'solar-outage');assert.equal(outage.scenario.active,true);
    assert.ok(outage.scenario.appliedKw>0&&outage.scenario.appliedKw<=360+1e-8);
    for(const bus of [5,7,14,21])assert.ok(Math.abs(outage.generationP[bus-1])<1e-8);
    await page.locator('#pr-matrix .matrix-cell[data-receiver="5"][data-source="7"]').click();
    await checkForecastObservation(page);
      await checkSourceHistory(page);
      await checkCommandInspection(page);
    await checkEventMarkers(page);
    await page.locator('#pr-source-fault').click();
    await checkEventMarkers(page);
    await page.screenshot({path:path.join(output,'solar-outage.png'),fullPage:true});
    await page.locator('#pr-run').click();
    await page.waitForFunction(()=>document.querySelector('#power-response-demo').powerDemo.getSnapshot().t>=51);
    await pause();
    assert.match(await page.locator('#pr-scenario-status').textContent(),/Solar restored/);
    assert.ok(await page.locator('.intervention-badge[aria-label*="Solar"]').count()>0,'Markers identify actual solar changes');
    await checkPlots();
    await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });

    await mark('solar outage and desktop evidence');

    const audit=await browser.newPage({viewport:{width:1440,height:1000}});
    audit.on('pageerror',error=>errors.push(error.message));
    await audit.goto(demoURL,{waitUntil:'networkidle'});
    await useReference(audit);
    await audit.locator('#pr-matrix .matrix-cell[data-receiver="5"][data-source="7"]').click();
    await audit.locator('#pr-source-fault').click();
    const errorsSeen=[];
    for(let i=0;i<62;i++){
      if(i===3)await audit.locator('#pr-source-fault').click();
      await stepSetting(audit);
      const reading=await checkSourceHistory(audit),sample=reading.snapshot.lastSample;
      assert.equal(reading.state.playing,false);
      errorsSeen.push(sample.forecast[6]-sample.disturbance[6]);
      const window=errorsSeen.slice(-60),rmse=Math.sqrt(window.reduce((sum,value)=>sum+value*value,0)/window.length),bias=window.reduce((sum,value)=>sum+value,0)/window.length;
      assert.ok(Math.abs(Number(reading.window.rmse)-rmse)<1e-12,'DOM rolling error matches independently collected revealed pairs');
      assert.ok(Math.abs(Number(reading.window.bias)-bias)<1e-12,'DOM bias uses the actual signed errors');
    }
    await audit.screenshot({path:path.join(output,'forecast-history.png'),fullPage:true});
    await audit.close();
    await mark('independent sixty two pair error audit');

    // Request expiry does not erase power already applied in the displayed sample.
    const pulseTail=await browser.newPage({viewport:{width:1440,height:1000}});
    pulseTail.on('pageerror',error=>errors.push(error.message));
    await pulseTail.goto(demoURL,{waitUntil:'networkidle'});
    await useReference(pulseTail);
    await pulseTail.locator('#pr-intervention').selectOption('power');
    await selectSetting(pulseTail,'attack-mode','pulse');
    const finalPulseEvidence=[];
    for(const [bus,steps,width] of [[23,12,1440],[7,24,1440],[8,8,1440],[8,8,390]]){
      await pulseTail.setViewportSize({width,height:1000});
      await selectSetting(pulseTail,'bus',String(bus));
      const result=await pulseTail.evaluate(({bus,steps,width})=>{
        document.querySelector('#pr-restart').click();
        const intervention=document.querySelector('#pr-intervention');intervention.value='power';intervention.dispatchEvent(new Event('change'));
        document.querySelector('#pr-pulse').click();
        document.querySelector('#pr-run').click();
        if(width===390){
          const selection=document.querySelector('#pr-bus');selection.value='23';selection.dispatchEvent(new Event('change'));
          document.querySelector('#pr-pulse').click();document.querySelector('#pr-run').click();
          selection.value=String(bus);selection.dispatchEvent(new Event('change'));
        }
        for(let i=0;i<steps;i++)document.querySelector('#pr-step').click();
        const root=document.querySelector('#power-response-demo'),snapshot=root.powerDemo.getSnapshot();
        const node=document.querySelector('#pr-network [data-bus="'+bus+'"]'),badge=node.querySelector('.pe-attack-badge');
        return {bus,t:snapshot.t,requests:snapshot.activePulses.filter(item=>item.bus===bus).length,applied:snapshot.lastPulseApplications.find(item=>item.bus===bus),
          visibleBadges:Array.from(document.querySelectorAll('#pr-network .pe-attack-badge')).filter(node=>getComputedStyle(node).display!=='none').map(node=>Number(node.closest('[data-bus]').dataset.bus)),
          visible:getComputedStyle(badge).display!=='none'&&badge.getAttribute('display')!=='none',
          badgePower:Number(badge.dataset.appliedPowerKw),text:badge.querySelector('.pe-attack-power').textContent,
          status:badge.dataset.attackState,toolbar:document.querySelector('#pr-pulse').dataset.attackState,
          costs:snapshot.cumulative,states:snapshot.states,events:snapshot.eventLog};
      },{bus,steps,width});
      assert.equal(result.t,steps);assert.equal(result.requests,0,'The request expires after its final sample');
      assert.ok(result.applied.appliedKw>0);assert.equal(result.visible,true,'Keep actual final applied power visible');
      assert.deepEqual(result.visibleBadges,[bus],'Current applications keep one selected full badge even if another bus still has an unexpired request');
      assert.ok(Math.abs(result.badgePower-result.applied.appliedKw)<1e-9,'Badge is the actual bounded current application');
      assert.match(result.text,new RegExp(Math.round(result.applied.appliedKw)+' kW'));
      assert.equal(result.status,'paused');assert.equal(result.toolbar,'paused');
      await pulseTail.locator('#pr-intervention').selectOption('forecast');
      await pulseTail.locator('#pr-intervention').selectOption('power');
      await pulseTail.reload({waitUntil:'networkidle'});
      const replay=await pulseTail.evaluate(bus=>{
        const root=document.querySelector('#power-response-demo'),snapshot=root.powerDemo.getSnapshot();
        const badge=document.querySelector('#pr-network [data-bus="'+bus+'"] .pe-attack-badge');
        return {t:snapshot.t,costs:snapshot.cumulative,states:snapshot.states,events:snapshot.eventLog,
          applied:snapshot.lastPulseApplications.find(item=>item.bus===bus),badgePower:Number(badge.dataset.appliedPowerKw),
          status:badge.dataset.attackState,toolbar:document.querySelector('#pr-pulse').dataset.attackState};
      },bus);
      for(const key of ['t','costs','states','events','applied','badgePower','status','toolbar'])assert.deepEqual(replay[key],result[key],'Final applied sample replay '+key);
      if(bus===8)await pulseTail.screenshot({path:path.join(output,width===390?'final-applied-power-mobile.png':'final-applied-power.png'),fullPage:true});
      await stepSetting(pulseTail);
      const cleared=await pulseTail.evaluate(bus=>{
        const root=document.querySelector('#power-response-demo'),snapshot=root.powerDemo.getSnapshot();
        const badge=document.querySelector('#pr-network [data-bus="'+bus+'"] .pe-attack-badge');
        return {applications:snapshot.lastPulseApplications.filter(item=>item.bus===bus),toolbar:document.querySelector('#pr-pulse').dataset.attackState,
          display:badge.getAttribute('display'),events:snapshot.eventLog.filter(event=>event.type==='pulse').length};
      },bus);
      assert.deepEqual(cleared.applications,[]);assert.equal(cleared.toolbar,'idle');assert.equal(cleared.display,'none');assert.equal(cleared.events,width===390?2:1);
      finalPulseEvidence.push({last:result,replay,cleared});
    }
    await fs.writeFile(path.join(output,'final-applied-power.json'),JSON.stringify(finalPulseEvidence,null,2));
    await pulseTail.close();
    await mark('final applied power sample and exact replay');

    // Actual paused pulse states distinguish request, voltage effect and charged cost.
    for(const width of [1440,390,320]){
      const context=await browser.newContext({viewport:{width,height:1000},isMobile:width<=650,hasTouch:width<=650});
      const surface=await context.newPage();surface.on('pageerror',error=>errors.push(error.message));
      await surface.goto(demoURL,{waitUntil:'networkidle'});
      await surface.locator('#pr-intervention').selectOption('power');
      await selectSetting(surface,'attack-mode','pulse');
      const before=await surface.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getSnapshot());
      // Queue and pause synchronously to avoid a viewing-speed timing assumption.
      await surface.evaluate(()=>{document.querySelector('#pr-pulse').click();document.querySelector('#pr-run').click();});
      const queued=await surface.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getSnapshot());
      assert.equal(queued.t,0);assert.equal(queued.pendingPulses.length,1);
      assert.deepEqual(queued.states,before.states);assert.deepEqual(queued.cumulative,before.cumulative);
      let caption=await checkStageCaptions(surface);assert.match(caption.summary,/Queued at t 0.*Run or Step/);
      await stepSetting(surface);
      const first=await surface.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getSnapshot());
      assert.equal(first.t,1);assert.ok(first.lastPulseApplications.some(item=>item.appliedKw>0));
      caption=await checkStageCaptions(surface);assert.equal(caption.summary,'Voltage changed · Cost appears next step');
      if(width!==320){
        const preview=await surface.locator('.pr-stage-panel').screenshot({path:path.join(output,'power-timing-'+width+'.jpg'),type:'jpeg',quality:90});
        console.log('CLOUD_TIMING_PREVIEW_'+width+' '+preview.toString('base64'));
        assert.equal(await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),caption.snapshot,'Timing screenshot cannot step the plant');
      }
      await stepSetting(surface);
      const charged=await surface.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getSnapshot());
      const expected=await surface.evaluate(beforeCost=>{
        const snapshot=document.querySelector('#power-response-demo').powerDemo.getSnapshot();
        return 'Cost '+d3.format('.3~g')(beforeCost)+' → '+d3.format('.3~g')(snapshot.history.find(item=>(item.costTime??item.t-1)===1).stage.online);
      },before.stage.online);
      caption=await checkStageCaptions(surface);assert.equal(caption.summary,expected,'The caption uses the real following action cost, never a fabricated immediate charge');
      await surface.reload({waitUntil:'networkidle'});
      assert.equal(await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),JSON.stringify(charged),'Caption layout preserves exact version 14 replay');
      await checkStageCaptions(surface);
      const replay=await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot()));
      await surface.locator('#pr-intervention').selectOption('forecast');
      caption=await checkStageCaptions(surface);assert.equal(caption.summary,'');
      assert.equal(await surface.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),replay,'Hiding an empty caption cannot erase power or cost');
      for(const chart of ['pr-voltage','pr-stage'])assert.equal(await surface.locator('#'+chart+' path.data-series').count(),4);
      await context.close();
    }
    await mark('queued applied and charged caption layout plus exact replay');


    // A later segment must use a pending source setting before issuing its preview.
    const segmentEvidence=[];
    for(const phase of ['discovery','continued-default']){
      const segmentPage=await browser.newPage({viewport:{width:1440,height:1000}});
      segmentPage.on('pageerror',error=>errors.push(error.message));
      await segmentPage.goto(demoURL,{waitUntil:'networkidle'});
      if(phase==='discovery')await useReference(segmentPage);
      await segmentPage.evaluate(()=>{
        const automatic=document.querySelector('#pr-auto-compare');automatic.checked=false;automatic.dispatchEvent(new Event('change'));
      });
      if(phase==='continued-default'){
        await segmentPage.evaluate(()=>{
          for(let i=0;i<31;i++)document.querySelector('#pr-step').click();
          document.querySelector('#pr-deploy').click();document.querySelector('#pr-run').click();
        });
      }
      const advance=async()=>{
        await segmentPage.evaluate(()=>document.querySelector('#pr-compare').click());
        await segmentPage.waitForFunction(()=>!document.querySelector('#pr-compare').disabled);
      };
      await advance();
      if(phase==='continued-default'){
        await advance();await advance();
        await segmentPage.evaluate(()=>{
          const root=document.querySelector('#power-response-demo');
          while(root.powerDemo.getSnapshot().t<root.powerDemo.getSnapshot().horizon)document.querySelector('#pr-step').click();
        });
      }
      await segmentPage.locator('#pr-matrix .matrix-cell[data-receiver="5"][data-source="7"]').click();
      const readSegment=async surface=>surface.evaluate(()=>{
        const root=document.querySelector('#power-response-demo'),s=root.powerDemo.getSnapshot(),state=root.powerDemo.getState();
        return {t:s.t,horizon:s.horizon,mode:s.mode,segments:s.segments,states:s.states,costs:s.cumulative,support:s.deployedSupport,
          sample:s.lastSample,events:s.eventLog,faults:s.faults,playing:state.playing,saved:window.openai.widgetState};
      });
      const before=await readSegment(segmentPage);
      assert.equal(before.mode,'completed');assert.equal(before.t,phase==='discovery'?180:660);
      await segmentPage.locator('#pr-source-fault').click();
      const pending=await readSegment(segmentPage);
      assert.equal(pending.mode,'completed');assert.equal(pending.playing,false);
      for(const key of ['t','horizon','segments','states','costs','support','sample'])assert.deepEqual(pending[key],before[key],'Boundary setting preserves '+key);
      assert.equal(pending.faults.includes(7),!before.faults.includes(7));
      assert.equal(pending.events.filter(event=>event.type==='extend').length,before.events.filter(event=>event.type==='extend').length,'A source setting alone does not add a segment');
      assert.equal(await segmentPage.locator('#pr-forecast-change').getAttribute('data-issued'),'false');
      await segmentPage.reload({waitUntil:'networkidle'});
      const restored=await readSegment(segmentPage);
      for(const key of ['t','horizon','mode','segments','states','costs','support','sample','events','faults'])assert.deepEqual(restored[key],pending[key],'Pending boundary replay '+key);
      const baseline=await browser.newPage({viewport:{width:1440,height:1000}});
      baseline.on('pageerror',error=>errors.push(error.message));
      await baseline.addInitScript(saved=>localStorage.setItem('online-predsls-offline-v1',JSON.stringify(saved)),before.saved);
      await baseline.goto(demoURL,{waitUntil:'networkidle'});
      await segmentPage.screenshot({path:path.join(output,'source-segment-'+phase+'.png'),fullPage:true});
      for(const surface of [segmentPage,baseline])await surface.evaluate(()=>{
        for(let i=0;i<5;i++)document.querySelector('#pr-step').click();
      });
      const executed=await readSegment(segmentPage),control=await readSegment(baseline);
      assert.equal(executed.t,before.t+5);assert.equal(executed.sample.t,before.t+4);
      assert.deepEqual(executed.sample.base,control.sample.base,'Paired realized base power is identical');
      assert.notEqual(executed.sample.forecast[6],control.sample.forecast[6],'First newly issued selected source uses the pending setting');
      for(let j=0;j<24;j++)if(j!==6)assert.equal(executed.sample.forecast[j],control.sample.forecast[j],'Other newly issued sources are identical');
      if(phase!=='discovery')assert.deepEqual(executed.support,before.support,'Comparison support remains frozen');
      assert.equal(executed.events.filter(event=>event.type==='extend').length,before.events.filter(event=>event.type==='extend').length+1,'Explicit stepping extends exactly once');
      segmentEvidence.push({phase,before:before.t,pending:{t:pending.t,horizon:pending.horizon,mode:pending.mode},executed:{t:executed.t,target:executed.sample.t,forecast:executed.sample.forecast[6]},controlForecast:control.sample.forecast[6]});
      await baseline.close();await segmentPage.close();
    }
    await fs.writeFile(path.join(output,'source-segment-boundaries.json'),JSON.stringify(segmentEvidence,null,2));
    await mark('source settings at ordinary and continued segment boundaries');

    // Forecast stress is a fresh experiment, with no power attacks carried over.
    const stress=await browser.newPage({viewport:{width:1440,height:1000}});
    stress.on('pageerror',error=>errors.push(error.message));
    await stress.goto(demoURL,{waitUntil:'networkidle'});
    await useReference(stress);
    await selectSetting(stress,'speed','32');
    await stress.locator('#pr-intervention').selectOption('power');
    for(const bus of [20,23])await stress.getByRole('button',{name:'Toggle continuous attack at bus '+bus,exact:true}).click();
    await stress.waitForFunction(()=>document.querySelector('#power-response-demo').powerDemo.getSnapshot().t>=3);
    assert.deepEqual((await readPowerAttacks(stress)).active,[20,23]);
    // A saved mixed reference run stays intact until the new scenario is chosen.
    const legacySaved=await stress.evaluate(()=>window.openai.widgetState);
    const migration=await browser.newPage({viewport:{width:1440,height:1000}});
    migration.on('pageerror',error=>errors.push(error.message));
    await migration.addInitScript(saved=>{localStorage.setItem('online-predsls-offline-v1',JSON.stringify(saved));},legacySaved);
    await migration.goto(demoURL,{waitUntil:'networkidle'});
    const legacy=await migration.evaluate(()=>{
      const root=document.querySelector('#power-response-demo'),snapshot=root.powerDemo.getSnapshot();
      return {scenario:snapshot.powerScenario,t:snapshot.t,costs:snapshot.cumulative,state:root.powerDemo.getState()};
    });
    assert.equal(legacy.scenario,'reference');assert.equal(legacy.t,legacySaved.privateContent.t);assert.equal(legacy.state.playing,false);
    assert.deepEqual(legacy.costs,legacySaved.modelContent.cumulativeCost);
    await withinSettings(migration,async()=>assert.equal(await migration.locator('#pr-new-scenario').isVisible(),true));
    assert.match(await migration.locator('#pr-scenario-description').getAttribute('title'),/Restored run/);
    assert.match(await migration.locator('#pr-trial-context').textContent(),/unforecast power requests/);
    await migration.screenshot({path:path.join(output,'restored-trial-new-scenario.png'),fullPage:true});
    await withinSettings(migration,()=>migration.locator('#pr-new-scenario').click());
    const started=await migration.evaluate(()=>{
      const root=document.querySelector('#power-response-demo'),snapshot=root.powerDemo.getSnapshot();
      return {scenario:snapshot.powerScenario,beta:snapshot.beta,events:snapshot.eventLog,state:root.powerDemo.getState()};
    });
    assert.equal(started.scenario,'forecasted-demand');assert.equal(started.beta,4);assert.equal(started.state.playing,true);
    assert.equal(started.events.some(event=>event.type==='pulse'),false);assert.deepEqual(started.state.activeAttackBuses,[]);
    await migration.locator('#pr-run').click();
    await migration.locator('#pr-adaptation > summary').click();
    for(const bus of [5,7,8,12,14,18,21,24]) {
      await migration.locator('#pr-bus').selectOption(String(bus));
      await migration.locator('#pr-fault').click();
    }
    await migration.locator('#pr-adaptation > summary').click();
    assert.equal(await migration.locator('#pr-trial-context').isVisible(),true);
    assert.match(await migration.locator('#pr-trial-context').textContent(),/All forecast sources are noisy.*No reliable alternative to select/);
    await withinSettings(migration,async()=>assert.equal(await migration.locator('#pr-new-scenario').isVisible(),true));
    await migration.screenshot({path:path.join(output,'all-sources-noisy.png'),fullPage:true});
    await withinSettings(migration,()=>migration.locator('#pr-new-scenario').click());
    assert.equal(await migration.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getSnapshot().faults.length),15);
    assert.equal(await migration.locator('#pr-trial-context').isVisible(),false);
    await migration.close();

    await selectSetting(stress,'noise','8');
    const freshStress=await stress.evaluate(()=>{
      const root=document.querySelector('#power-response-demo'),snapshot=root.powerDemo.getSnapshot(),state=root.powerDemo.getState();
      return {beta:snapshot.beta,phase:snapshot.phase,t:snapshot.t,cumulative:snapshot.cumulative,
        events:snapshot.eventLog,pending:snapshot.pendingPulses,physical:snapshot.activePulses,
        active:state.activeAttackBuses,intervention:state.intervention,playing:state.playing};
    });
    assert.equal(freshStress.beta,8);assert.equal(freshStress.phase,'discovery');assert.equal(freshStress.t,0);
    assert.equal(freshStress.playing,false);assert.equal(freshStress.intervention,'forecast');
    for(const key of ['online','scalar','static','causal'])assert.equal(freshStress.cumulative[key],0,'New stress trial starts with zero accumulated cost');
    for(const key of ['events','pending','physical','active'])assert.deepEqual(freshStress[key],[],'New stress trial clears '+key);
    assert.equal(await stress.locator('#pr-noise option:checked').textContent(),'8');
    assert.match(await stress.locator('#pr-noise-caption').textContent(),/Bus \d+ · SD [\d.e+-]+ mpu/);
    await stress.locator('#pr-run').click();
    await stress.waitForFunction(()=>{
      const snapshot=document.querySelector('#power-response-demo').powerDemo.getSnapshot();
      return snapshot.phase==='deployment'&&snapshot.t>=60;
    },null,{timeout:30000});
    await stress.locator('#pr-run').click();
    const stressResult=await stress.evaluate(()=>{
      const snapshot=document.querySelector('#power-response-demo').powerDemo.getSnapshot();
      return {beta:snapshot.beta,phase:snapshot.phase,t:snapshot.t,cumulative:snapshot.cumulative,
        commandQ:snapshot.commandQ,events:snapshot.eventLog,
        table:Array.from(document.querySelectorAll('#pr-cost-detail tr')).map(row=>({key:row.dataset.method,cost:Number(row.querySelector('[data-cost]').dataset.cost)}))};
    });
    assert.equal(stressResult.phase,'deployment');assert.equal(stressResult.beta,8);
    assert.equal(stressResult.events.some(event=>event.type==='pulse'),false,'No hidden physical attack enters the forecast comparison');
    assert.deepEqual(stressResult.table.map(row=>row.key),['online','scalar','static','causal']);
    for(const row of stressResult.table)assert.equal(row.cost,stressResult.cumulative[row.key],'Every displayed cost is the actual executed cumulative cost');
    for(const key of ['online','scalar','static'])assert.ok(stressResult.commandQ[key].some(value=>Math.abs(value)>1e-9),'Stress runs actual predictive controller commands');
    for(const chart of ['pr-cost','pr-stage','pr-voltage']) {
      const paths=await stress.locator('#'+chart+' path.data-series').evaluateAll(elements=>elements.map(element=>({key:element.dataset.seriesKey,d:element.getAttribute('d')})));
      assert.equal(paths.length,4,'Forecast stress retains every '+chart+' controller curve');
      assert.ok(paths.some(item=>item.key==='causal'),'Feedback remains visible in '+chart);
      assert.ok(paths.every(item=>item.d&&!/NaN|Infinity/.test(item.d)),'Forecast stress has finite measured paths');
    }
    await stress.locator('#pr-matrix .matrix-cell[data-receiver="5"][data-source="6"]').click();
    await checkCommandInspection(stress);
    const predictionTerms=await stress.locator('#pr-command-rows tr').evaluateAll(rows=>rows.map(row=>({key:row.dataset.controller,prediction:Number(row.dataset.sourceKvar)+Number(row.dataset.otherKvar)})));
    for(const key of ['online','scalar','static'])assert.ok(Math.abs(predictionTerms.find(row=>row.key===key).prediction)>1e-9,'Forecast stress contributes to actual '+key+' prediction commands');
    assert.equal(predictionTerms.find(row=>row.key==='causal').prediction,0,'Feedback only receives no prediction contribution');
    await checkVoltageMetrics(stress);await checkProtocol(stress);
    await stress.locator('#pr-adaptation > summary').click();
    await stress.locator('#pr-bus').selectOption('6');
    await stress.locator('#pr-adaptation > summary').click();
    assert.match(await stress.locator('#pr-noise-caption').textContent(),/Bus 6.*mpu/,'The selected noisy source has a visible forcing error scale');
    await stress.screenshot({path:path.join(output,'forecast-stress-desktop.png'),fullPage:true});
    await fs.writeFile(path.join(output,'forecast-stress.json'),JSON.stringify({fresh:freshStress,comparison:stressResult},null,2));
    await selectSetting(stress,'noise','16');
    for(let i=0;i<6;i++)await stepSetting(stress);
    const savedStress=await stress.evaluate(()=>({saved:window.openai.widgetState,
      snapshot:((snapshot)=>({beta:snapshot.beta,t:snapshot.t,states:snapshot.states,cumulative:snapshot.cumulative}))(document.querySelector('#power-response-demo').powerDemo.getSnapshot())}));
    assert.equal(savedStress.saved.privateContent.initialOptions.beta,16);
    const restoredStress=await browser.newPage({viewport:{width:1440,height:1000}});
    restoredStress.on('pageerror',error=>errors.push(error.message));
    await restoredStress.addInitScript(saved=>{localStorage.setItem('online-predsls-offline-v1',JSON.stringify(saved));},savedStress.saved);
    await restoredStress.goto(demoURL,{waitUntil:'networkidle'});
    const restoredResult=await restoredStress.evaluate(()=>{
      const snapshot=document.querySelector('#power-response-demo').powerDemo.getSnapshot();
      return {beta:snapshot.beta,t:snapshot.t,states:snapshot.states,cumulative:snapshot.cumulative};
    });
    assert.deepEqual(restoredResult,savedStress.snapshot,'Extended stress restores the same measured trial');
    assert.equal(await restoredStress.locator('#pr-noise').inputValue(),'16');
    assert.match(await restoredStress.locator('#pr-noise-caption').textContent(),/Bus \d+ · SD [\d.e+-]+ mpu/);
    await selectSetting(restoredStress,'noise','1');
    assert.equal(await restoredStress.locator('#pr-noise').inputValue(),'1');
    assert.equal(await restoredStress.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getSnapshot().t),0);
    assert.equal(await restoredStress.locator('#pr-noise option:checked').textContent(),'1');
    await restoredStress.close();await stress.close();
    await mark('forecast stress reset handoff and saved trial');

    // A narrow touch viewport keeps the controls usable and the page in bounds.
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    const phone = await mobile.newPage();
    phone.on('pageerror', error => errors.push(error.message));
    await phone.goto(demoURL, { waitUntil: 'networkidle' });
    const mobileDefault=await phone.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getSnapshot().powerScenario);
    assert.equal(mobileDefault,'forecasted-demand');
    await captureForecastSettings(phone);
    await checkControllerKey(phone,true);
    await stepSetting(phone);
    assert.ok(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Default scenario fits the narrow mobile page');
    await phone.screenshot({path:path.join(output,'default-scenario-mobile.png'),fullPage:true});
    await checkExperimentProgress(phone);await checkValidationReport(phone);
    await useReference(phone);
    await selectSetting(phone,'speed','32');
    await selectSetting(phone,'view','cost');
    await phone.locator('#pr-run').tap();
    for(const metric of ['gap','total','gap']){
      await phone.locator('#pr-cost-'+metric).tap();await checkCostSwitch(phone,metric,'scalar adaptation');
      assert.equal(await phone.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getState().playing),true,'Mobile quantity taps preserve playback');
      const bounds=await phone.locator('#pr-cost-'+metric).boundingBox();
      assert.ok(bounds.width>=44&&bounds.height>=44,'Cost quantity has a usable mobile touch target');
    }
    await phone.locator('#pr-run').tap();
    await phone.locator('.pr-learning-panel').screenshot({path:path.join(output,'cost-switch-difference-mobile.png')});
    await phone.locator('#pr-cost-total').tap();await checkCostSwitch(phone,'total','scalar adaptation');
    const touchEvents = [];
    await phone.exposeFunction('__recordSmokeTouch', event => touchEvents.push(event));
    await phone.evaluate(() => {
      for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click', 'gotpointercapture', 'lostpointercapture']) {
        document.addEventListener(type, event => {
          const bus = event.target.closest('[data-bus]');
          window.__recordSmokeTouch({ type, detail: event.detail, pointerType: event.pointerType, bus: bus?.getAttribute('data-bus'), label: bus?.getAttribute('aria-label'), target: event.target.tagName, x: event.clientX, y: event.clientY });
        }, true);
      }
    });
    try {
      await phone.getByRole('button', { name: 'Corrupt forecast at bus 7', exact: true }).tap();
      await phone.getByRole('button', { name: 'Repair forecast at bus 7', exact: true }).waitFor();
      await phone.getByRole('button', { name: 'Repair forecast at bus 7', exact: true }).tap();
      await phone.getByRole('button', { name: 'Corrupt forecast at bus 7', exact: true }).waitFor();
      await phone.locator('#pr-intervention').selectOption('power');
      for(const bus of [20,22,23])await phone.getByRole('button',{name:'Toggle continuous attack at bus '+bus,exact:true}).tap();
      await phone.getByRole('button',{name:'Stop attack at bus 23',exact:true}).waitFor();
      assert.equal(await phone.locator('#pr-pulse').getAttribute('aria-pressed'),'true');
      const attackStart=Number((await phone.locator('#pr-clock').textContent()).match(/(\d+) s/)[1]);
      await phone.waitForFunction(target=>Number(document.querySelector('#pr-clock').textContent.match(/(\d+) s/)[1])>=target,attackStart+3);
      await checkPowerAttacks(phone,[20,22,23]);
      await phone.screenshot({path:path.join(output,'concurrent-attacks-mobile.png'),fullPage:true});
      await phone.getByRole('button',{name:'Stop attack at bus 22',exact:true}).tap();
      const mobileStopped=await readPowerAttacks(phone);
      await selectSetting(phone,'bus','23');
      await phone.waitForFunction(target=>Number(document.querySelector('#pr-clock').textContent.match(/(\d+) s/)[1])>=target,mobileStopped.t+3);
      const mobileContinuing=await checkPowerAttacks(phone,[20,23]);
      assert.equal(mobileContinuing.counts[22],mobileStopped.counts[22],'A touch stops only its bus');
      for(const bus of [20,23])assert.ok(mobileContinuing.counts[bus]>mobileStopped.counts[bus]);
      const stopBounds=await phone.locator('#pr-stop-attacks').boundingBox();
      assert.ok(stopBounds.width>=44&&stopBounds.height>=44,'Stop all has a usable touch target');
      await phone.getByRole('button',{name:'Stop all 2 active buses',exact:true}).tap();
      await phone.getByRole('button',{name:'Toggle continuous attack at bus 23',exact:true}).waitFor();
      assert.equal(await phone.locator('#pr-pulse').getAttribute('aria-pressed'),'false');
      assert.deepEqual((await readPowerAttacks(phone)).active,[]);
    } catch (error) {
      const details = await phone.evaluate(() => ({
        bus7: document.querySelector('[data-bus="7"]')?.getAttribute('aria-label'),
        selectedAction: document.querySelector('#pr-pulse-label')?.textContent,
        clock: document.querySelector('#pr-clock')?.textContent,
        status: document.querySelector('#pr-event')?.textContent,
        alert: document.querySelector('#pr-error')?.textContent,
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        scrollY
      }));
      const diagnostic = { passed: false, browser: browser.version(), check: 'mobile bus interactions', details, touchEvents, errors, failure: error.message };
      console.error(JSON.stringify(diagnostic, null, 2));
      await fs.writeFile(path.join(output, 'mobile-failure.json'), JSON.stringify(diagnostic, null, 2));
      await phone.screenshot({ path: path.join(output, 'mobile-failure.png'), fullPage: true });
      throw error;
    }
    await mark('repeated mobile forecast and power taps');
    await phone.locator('#pr-run').tap();
    await phone.locator('#pr-matrix .matrix-cell[data-receiver="5"][data-source="7"]').tap();
    let mobileBefore=await phone.evaluate(()=>{
      const root=document.querySelector('#power-response-demo');return {state:root.powerDemo.getState(),snapshot:root.powerDemo.getSnapshot()};
    });
    assert.equal(mobileBefore.state.playing,false);
    assert.equal(mobileBefore.state.inspectedSource,7);assert.equal(mobileBefore.state.selectedBus,5);assert.equal(mobileBefore.state.historyIndex,null);
    // Native pause can land exactly on the fresh automatic comparison handoff.
    // Require a real executed action rather than treating pending rows as commands.
    if(!mobileBefore.snapshot.lastSample){
      assert.equal(mobileBefore.snapshot.phase,'deployment');assert.equal(mobileBefore.snapshot.t,0);
      await phone.locator('#pr-step').tap();
      mobileBefore=await phone.evaluate(()=>{const root=document.querySelector('#power-response-demo');return {state:root.powerDemo.getState(),snapshot:root.powerDemo.getSnapshot()};});
      assert.equal(mobileBefore.snapshot.t,1);assert.equal(mobileBefore.snapshot.lastSample.t,0);assert.equal(mobileBefore.state.playing,false);
    }
    await phone.locator('#pr-command-title').tap();
    await checkCommandInspection(phone);
    assert.equal(await phone.locator('#pr-command-gain-heading').textContent(),'Gain norm');
    assert.equal(await phone.locator('#pr-command-rows .source-gain').count(),4);
    const scroller=phone.getByRole('region',{name:'Receiver command table',exact:true});
    await scroller.focus();
    for(let i=0;i<12;i++)await scroller.press('ArrowRight');
    await phone.waitForFunction(()=>document.querySelector('.pr-command-scroll').scrollLeft>0);
    const keyboardBefore=await phone.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot()));
    await scroller.press('Space');
    assert.equal(await phone.evaluate(()=>document.querySelector('#power-response-demo').powerDemo.getState().playing),false,'Space in the command scroller must not start playback');
    assert.equal(await phone.evaluate(()=>JSON.stringify(document.querySelector('#power-response-demo').powerDemo.getSnapshot())),keyboardBefore);
    await scroller.evaluate(el=>{el.scrollLeft=el.scrollWidth;});
    const gainBox=await phone.locator('#pr-command-rows .source-gain').first().boundingBox();
    assert.ok(gainBox.x>=0&&gainBox.x+gainBox.width<=390+1,'Gain is reachable inside the mobile table scroller');
    await phone.screenshot({path:path.join(output,'source-gains-mobile.png'),fullPage:true});
    for(const action of ['Corrupt','Repair']) {
      await phone.getByRole('button',{name:action+' forecast source at bus 7',exact:true}).tap();
      const mobileAfter=await phone.evaluate(()=>{
        const root=document.querySelector('#power-response-demo');return {state:root.powerDemo.getState(),snapshot:root.powerDemo.getSnapshot()};
      });
      await checkForecastObservation(phone);
      await checkSourceHistory(phone);
      await checkCommandInspection(phone);
      assert.equal(mobileAfter.snapshot.faults.includes(7),action==='Corrupt');
      assert.equal(mobileAfter.state.selectedBus,5);assert.equal(mobileAfter.state.inspectedSource,7);
      assert.equal(mobileAfter.state.playing,false);
      assert.equal(mobileAfter.snapshot.t,mobileBefore.snapshot.t);
      assert.deepEqual(mobileAfter.snapshot.states,mobileBefore.snapshot.states);
      assert.deepEqual(mobileAfter.snapshot.cumulative,mobileBefore.snapshot.cumulative);
    }
    await checkVoltageMetrics(phone);
    await checkProtocol(phone);
    await checkEventMarkers(phone);
    // A touch briefly scales the button. Check its settled target after that animation.
    await phone.waitForFunction(()=>{
      const bounds=document.querySelector('#pr-source-fault').getBoundingClientRect();
      return bounds.width>=44&&bounds.height>=44;
    });
    const sourceBounds=await phone.locator('#pr-source-fault').boundingBox();
    assert.ok(sourceBounds.width>=44&&sourceBounds.height>=44,'Explicit source action has a usable touch target '+JSON.stringify(sourceBounds));
    const dimensions = await phone.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(dimensions.page <= dimensions.viewport + 1, 'Mobile page does not overflow horizontally');
    const attackBounds = await phone.locator('#pr-pulse').boundingBox();
    assert.ok(attackBounds.width >= 44 && attackBounds.height >= 44, 'Primary touch target remains at least 44 pixels');
    await withinSettings(phone,()=>phone.locator('#pr-compare').click());
    await phone.waitForFunction(()=>!document.querySelector('#pr-compare').disabled);
    await checkExperimentProgress(phone);
    await inspectLinkEvidence(phone);
    assert.ok(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'The cost table and persistent stages fit the mobile page');
    await phone.locator('.pr-learning-panel').screenshot({path:path.join(output,'comparison-mobile.png')});
    await captureExperimentProgress(phone);
    await captureNetworkInspection(phone);
    await captureDashboard(phone);
    await phone.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
    await selectSetting(phone,'noise','8');
    assert.match(await phone.locator('#pr-noise-caption').textContent(),/Bus \d+ · SD [\d.e+-]+ mpu/);
    await stepSetting(phone);
    const stressLayout=await phone.evaluate(()=>({page:document.documentElement.scrollWidth,viewport:innerWidth,
      beta:document.querySelector('#power-response-demo').powerDemo.getSnapshot().beta}));
    assert.equal(stressLayout.beta,8);assert.ok(stressLayout.page<=stressLayout.viewport+1,'Forecast stress controls fit the mobile page');
    await phone.screenshot({path:path.join(output,'forecast-stress-mobile.png'),fullPage:true});
    // The alternate experiment must not inherit Learned sparse ownership labels.
    await selectSetting(phone,'experiment','prediction');
    await captureLinkOwner(phone,'390-prediction-discovery');
    await withinSettings(phone,()=>phone.locator('#pr-compare').click());
    await phone.waitForFunction(()=>!document.querySelector('#pr-compare').disabled);
    if(await phone.locator('#pr-run').textContent()==='Pause')await phone.locator('#pr-run').tap();
    await captureLinkOwner(phone,'390-prediction-deployment');
    await phone.goto(origin+'/environment.html',{waitUntil:'networkidle'});
    const reportLayout=await phone.evaluate(()=>({page:document.documentElement.scrollWidth,viewport:innerWidth}));
    assert.ok(reportLayout.page<=reportLayout.viewport+1,'Scientific report stays within the mobile page');
    await phone.screenshot({path:path.join(output,'environment.png'),fullPage:true});
    await mark('mobile inspection and responsive evidence');
    assert.deepEqual(errors, [], 'No browser runtime errors');
    await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify({ passed: true, browser: browser.version(), timings, touchEvents, checks: ['actual cost versus remote prediction budget for all four designs', 'design tradeoff independent of curve visibility and cost display', 'same-budget sparse marker overlap remains visible', 'current validation source provenance replaces legacy benchmark values', 'reading validation provenance preserves paused live state on desktop and mobile', 'primary controls and four panels stay visible while advanced settings start closed', 'restart returns to a fresh learning trial with selected options', 'pending source settings at every finite segment preserve exact replay and first new issuance', 'final applied power remains visible after request expiry with exact replay', 'paused completed source settings preserve Continue and exact replay', 'restored mixed trial preserves old costs until explicit new scenario', 'all noisy sources notice and fresh reliable inverter map', 'shipped demand and solar default completes and pauses after 180 comparison samples', 'actual scheduled power visual metadata and forecasted event labels', 'completed default restores and explicitly continues', 'extended forecast stress clears previous power attacks and costs', 'all four measured forecast stress curves and actual prediction commands', 'extended stress saved trial replay and reference return', 'forecast stress desktop and mobile layout', 'actual forecast setting timestamps and typed mixed event markers', 'keyboard matrix inspection and native command table scrolling', 'visible temporal source gain without hover', 'playback', 'repeated forecast bus clicks', 'three simultaneous continuous power attacks and independent stop', 'all attack sources survive automatic handoff', 'actual protocol receipt and hidden topology archive', 'live matrix modes preserve source controls without advancing plant', 'four controller curves', 'nominal voltage diagnostics for all four controllers', 'thirty real cost button clicks at 32x without pausing', 'stable cost button and focus across held pointer samples', 'native Enter and Space cost activation', 'zero baseline and all four curves in both quantities', 'saved gap state restoration', 'mobile cost button taps and target sizes', 'repeated mobile forecast taps', 'explicit inspected source actions on desktop and mobile', 'raw revealed source forecast errors and issue times', 'rolling sixty-pair error and pending issuance timing', 'independent paused browser source error stream', 'actual receiver command decomposition and limiter on desktop and mobile', 'three simultaneous mobile power attacks and independent stop', 'mobile touch and layout'], errors }, null, 2));
    console.log('Browser smoke passed');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
