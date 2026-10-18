'use strict';

// Network switching is tested through visible controls and real playback.
// The read only hook supplies measured state, never an alternative test path.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const networks = {
  toy8: { buses: 8, receivers: 3, solar: 2, sparse: 6, dense: 18 },
  feeder24: { buses: 24, receivers: 8, solar: 4, sparse: 24, dense: 176 },
  feeder47: { buses: 47, receivers: 16, solar: 8, sparse: 48, dense: 720 }
};

async function main() {
  const root = path.resolve(__dirname, '..');
  // Both pages are required build artifacts; a legacy fallback hides a stale build.
  await Promise.all(['index.html','demo.html'].map(file=>fs.access(path.join(root,file))));
  const output = process.env.DEMO_NETWORK_OUTPUT || path.join(process.env.DEMO_SMOKE_OUTPUT || path.join(root, 'browser-results'), 'networks');
  await fs.mkdir(output, { recursive: true });
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = path.resolve(root, pathname === '/' ? 'index.html' : '.' + pathname);
      if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      response.end(await fs.readFile(file));
    } catch (_) { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const errors = [], checks = [], results = [];
  const origin = `http://127.0.0.1:${server.address().port}`;
  const homeURL=origin+'/',demoURL=origin+'/demo.html';
  const read = surface => surface.evaluate(() => {
    const demo = document.querySelector('#power-response-demo').powerDemo;
    return { snapshot: demo.getSnapshot(), state: demo.getState() };
  });
  const withinSettings = async (surface, action) => {
    const opened = await surface.locator('#pr-adaptation').getAttribute('open') !== null;
    if (!opened) await surface.locator('#pr-adaptation > summary').click();
    await action();
    if (!opened) await surface.locator('#pr-adaptation > summary').click();
  };
  const setting = (surface, id, value) => withinSettings(surface, () => surface.locator('#pr-' + id).selectOption(value));
  const pause = async surface => {
    if ((await read(surface)).state.playing) await surface.locator('#pr-run').click();
    assert.equal((await read(surface)).state.playing, false);
  };
  const waitSamples = async (surface, count) => {
    const before = await read(surface);
    await surface.waitForFunction(({ phase, target }) => {
      const s = document.querySelector('#power-response-demo').powerDemo.getSnapshot();
      return s.phase !== phase || s.t >= target;
    }, { phase: before.snapshot.phase, target: before.snapshot.t + count }, { timeout: 30000 });
  };
  const checkLayout = async (surface, id) => {
    const expected = networks[id], measured = await surface.evaluate(() => ({
      viewport: innerWidth, page: document.documentElement.scrollWidth,
      buses: document.querySelectorAll('#pr-network .bus-node').length,
      edges: document.querySelectorAll('#pr-network .physical line').length,
      cells: document.querySelectorAll('#pr-matrix .matrix-cell').length,
      rows: document.querySelectorAll('#pr-matrix .matrix-rows g').length,
      sources: document.querySelectorAll('#pr-matrix .matrix-columns text').length,
      networkLabel: document.querySelector('#pr-network').getAttribute('aria-label'),
      summary: document.querySelector('[data-network-summary]')?.textContent,
      scrolls: Array.from(document.querySelectorAll('.pr-network-scroll, .pr-matrix-scroll')).map(node => ({
        width: node.clientWidth, content: node.scrollWidth, overflow: getComputedStyle(node).overflowX,
        left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right
      })),
      matrixLabels: Array.from(document.querySelectorAll('#pr-matrix .matrix-columns text, #pr-matrix .matrix-rows text')).map(node => {
        const box = node.getBoundingClientRect();
        return { text: node.textContent, font: parseFloat(getComputedStyle(node).fontSize), width: box.width, height: box.height };
      })
    }));
    assert.equal(measured.buses, expected.buses, id + ' shows every bus');
    assert.equal(measured.edges, expected.buses - 1, id + ' has one radial tree');
    assert.equal(measured.cells, expected.receivers * (expected.buses - 1), id + ' retains every matrix cell');
    assert.equal(measured.rows, expected.receivers);
    assert.equal(measured.sources, expected.buses - 1);
    assert.match(measured.networkLabel, new RegExp('\\b' + expected.buses + '\\b'));
    assert.equal(measured.summary,undefined,'The redundant network footer is removed');
    assert.ok(measured.page <= measured.viewport + 1, id + ' has no page level horizontal overflow');
    assert.equal(await surface.locator('#pr-reference-study').isVisible(), true, 'Current validation provenance applies to every declared network');
    assert.equal(await surface.locator('.pr-study-overview').count(), 0, 'No old network benchmark is displayed as new evidence');
    for (const label of measured.matrixLabels) {
      assert.ok(label.width > 0 && label.height > 0, 'All matrix numbers are rendered');
      assert.ok(label.font >= (id === 'feeder47' ? 12 : 11), 'Network size does not reduce matrix label type');
    }
    if (id === 'feeder47' && measured.viewport <= 650) {
      assert.equal(measured.scrolls.length, 2, 'Only the network and full matrix receive dedicated scrolling');
      for (const scroller of measured.scrolls) {
        assert.ok(scroller.content > scroller.width + 1, 'Larger network uses real native horizontal scrolling');
        assert.match(scroller.overflow, /auto|scroll/);
        assert.ok(scroller.left >= -1 && scroller.right <= measured.viewport + 1);
      }
      for (const selector of ['.pr-network-scroll', '.pr-matrix-scroll']) {
        const moved = await surface.locator(selector).evaluate(node => {
          const initial = node.scrollLeft; node.scrollLeft = node.scrollWidth;
          const end = node.scrollLeft; node.scrollLeft = initial; return end;
        });
        assert.ok(moved > 0, 'Native horizontal scrolling reaches the hidden columns');
      }
    }
    checks.push(id + ' geometry and evidence scope at ' + measured.viewport);
  };
  const inspectMatrixNavigation = async (surface, capture=false) => {
    await pause(surface);
    const before=await read(surface),scroller=surface.locator('.pr-matrix-scroll'),hint=surface.locator('#pr-matrix-scroll-hint');
    assert.equal(before.snapshot.networkId,'feeder47');
    assert.equal(await scroller.getAttribute('aria-describedby'),'pr-matrix-scroll-hint');
    await scroller.scrollIntoViewIfNeeded();
    const seen=new Set(),initial=await scroller.evaluate(node=>node.scrollLeft);
    const move=async fraction=>{
      await scroller.evaluate((node,fraction)=>{node.scrollLeft=fraction*(node.scrollWidth-node.clientWidth);},fraction);
      // Consecutive middle positions share the same direction text. Wait for
      // native scroll dispatch and paint, not just that unchanged text.
      await scroller.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const position=fraction===0?'start':fraction===1?'end':'middle';
      await surface.waitForFunction(position=>document.querySelector('#pr-matrix-scroll-hint').dataset.position===position,position);
      const measured=await scroller.evaluate(node=>{
        const bounds=node.getBoundingClientRect(),columns=Array.from(node.querySelectorAll('.matrix-columns text')),svg=node.querySelector('svg').getBoundingClientRect();
        const axis=node.querySelector('.matrix-receiver-background').getBoundingClientRect(),sourceTitle=node.querySelector('.matrix-source-title').getBoundingClientRect();
        const visible=columns.filter(label=>{const box=label.getBoundingClientRect();return box.left>=axis.right-.5&&box.right<=bounds.right+.5;}).map(label=>Number(label.firstChild.nodeValue));
        const receivers=Array.from(node.querySelectorAll('.matrix-rows g')).map(row=>{
          const box=row.querySelector('text').getBoundingClientRect(),point=row.querySelector('rect').getBoundingClientRect();
          return {bus:row.__data__,left:box.left,right:box.right,centre:(box.top+box.bottom)/2,rowCentre:(point.top+point.bottom)/2,
            hit:document.elementFromPoint((point.left+point.right)/2,(point.top+point.bottom)/2)?.closest('g')===row};
        });
        const hits=Array.from(node.querySelectorAll('.matrix-cell')).filter(cell=>{const box=cell.getBoundingClientRect();return box.left>=axis.right&&box.right<=bounds.right;}).map(cell=>{
          const box=cell.getBoundingClientRect();return document.elementFromPoint((box.left+box.right)/2,(box.top+box.bottom)/2)?.closest('.matrix-cell')===cell;
        });
        const edgeLabels=columns.map((label,i)=>{
          const box=label.getBoundingClientRect(),centre=Number(label.dataset.columnX),width=Number(label.dataset.columnWidth);
          const guide=node.querySelectorAll('.matrix-columns line')[i],x=Number(label.getAttribute('x'));
          return {source:Number(label.firstChild.nodeValue),exposed:svg.left+centre+width/2>axis.right&&svg.left+centre-width/2<bounds.right,
            left:box.left,right:box.right,top:box.top,bottom:box.bottom,centre,x,
            guideStart:guide?Number(guide.getAttribute('x1')):null,guideEnd:guide?Number(guide.getAttribute('x2')):null,
            display:getComputedStyle(label).display,visibility:getComputedStyle(label).visibility};
        });
        const hint=document.querySelector('#pr-matrix-scroll-hint');
        return {edgeLabels,visible,axis:{left:axis.left,right:axis.right},bounds:{left:bounds.left,right:bounds.right},sourceTitle:{left:sourceTitle.left,right:sourceTitle.right},receivers,hits,text:hint.textContent,hidden:hint.hidden,data:{...hint.dataset},sources:columns.map(label=>Number(label.firstChild.nodeValue)),
          cells:node.querySelectorAll('.matrix-cell').length,left:node.scrollLeft,maximum:node.scrollWidth-node.clientWidth,font:parseFloat(getComputedStyle(hint).fontSize)};
      });
      assert.equal(measured.hidden,false);assert.ok(measured.font>=12);
      assert.ok(Math.abs(measured.axis.left-measured.bounds.left)<1,'Receiver gutter stays at the viewport edge');
      assert.equal(measured.receivers.length,16);
      for(const row of measured.receivers){assert.ok(row.left>=measured.bounds.left&&row.right<measured.axis.right,'Every inverter number remains fully visible');assert.ok(Math.abs(row.centre-row.rowCentre)<3,'Receiver numbers stay aligned with their row');assert.equal(row.hit,true,'Every pinned receiver remains an actual pointer target');}
      assert.ok(measured.sourceTitle.left>=measured.axis.right&&measured.sourceTitle.right<=measured.bounds.right,'Source title stays over visible columns');
      assert.ok(measured.hits.length>0&&measured.hits.every(Boolean),'Uncovered source cells retain their real hit targets');
      const exposed=measured.edgeLabels.filter(label=>label.exposed);
      for(const label of exposed){
        assert.ok(label.left>=measured.axis.right-.5&&label.right<=measured.bounds.right+.5,'Every exposed column has a whole source number, not a clipped digit '+label.source);
        assert.notEqual(label.display,'none');assert.equal(label.visibility,'visible','Sources are never hidden to repair clipping');
        assert.equal(label.guideStart,label.x,'The existing guide follows the label');
        assert.equal(label.guideEnd,label.centre,'The guide still points to the actual source column');
      }
      const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>.5&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.5;
      for(let i=0;i<exposed.length;i++)for(let k=i+1;k<exposed.length;k++)assert.ok(!overlap(exposed[i],exposed[k]),'Whole edge numbers do not overlap '+exposed[i].source+' and '+exposed[k].source);
      measured.visible.forEach(source=>seen.add(source));
      assert.deepEqual(measured.sources,Array.from({length:46},(_,i)=>i+2),'Scrolling retains every source header in order');
      assert.equal(measured.cells,736,'Scrolling retains all 16 by 46 actual cells');
      assert.equal(Number(measured.data.first),measured.visible[0]);assert.equal(Number(measured.data.last),measured.visible.at(-1));
      assert.ok(measured.text.includes('Sources '+measured.visible[0]+' to '+measured.visible.at(-1)),'Cue names the source numbers actually readable in the viewport');
      if(fraction===0){assert.equal(measured.visible[0],2);assert.ok(measured.text.endsWith('Scroll right →'));assert.ok(!measured.text.startsWith('←'));}
      else if(fraction===1){assert.equal(measured.visible.at(-1),47);assert.ok(measured.text.startsWith('← Scroll left'));assert.ok(!measured.text.endsWith('→'));}
      else {assert.ok(measured.text.startsWith('←'));assert.ok(measured.text.endsWith('→'));}
      if(capture&&[0,.5,1].includes(fraction)){
        const width=surface.viewportSize().width,preview=await surface.locator('.pr-matrix-panel').screenshot({path:path.join(output,'matrix-navigation-'+width+'-'+position+'.jpg'),type:'jpeg',quality:85});
        console.log('CLOUD_MATRIX_NAV_'+width+'_'+position+' '+preview.toString('base64'));
      }
    };
    await move(0);await scroller.focus();
    for(let i=0;i<6;i++)await scroller.press('ArrowRight');
    await surface.waitForFunction(()=>document.querySelector('.pr-matrix-scroll').scrollLeft>0);
    assert.ok((await hint.textContent()).includes('Sources'),'Native keyboard scrolling keeps the cue available');
    // Let the browser finish its native keyboard scroll animation before setting a new position.
    await scroller.evaluate(node=>new Promise(resolve=>{
      let last=node.scrollLeft,quietSince=performance.now();
      const settled=()=>{const now=performance.now();if(node.scrollLeft!==last){last=node.scrollLeft;quietSince=now;}
        if(now-quietSince>=250)resolve();else requestAnimationFrame(settled);};
      requestAnimationFrame(settled);
    }));
    for(const fraction of [0,.037,.123,.371,.5,.713,.937,1])await move(fraction);
    assert.deepEqual([...seen].sort((a,b)=>a-b),Array.from({length:46},(_,i)=>i+2),'Scrolling exposes every source beyond the fixed receiver labels');
    await scroller.evaluate((node,left)=>{node.scrollLeft=left;},initial);
    const after=await read(surface);
    assert.deepEqual(after.snapshot,before.snapshot,'Navigating the viewport changes no forecasts, state, support, event or cost');
    assert.equal(after.state.inspectedSource,before.state.inspectedSource);assert.equal(after.state.selectedBus,before.state.selectedBus);
    assert.equal(after.state.playing,false);
    checks.push('Pinned inverter labels, visible source title, truthful uncovered ranges, real row and cell hit targets, all source reachability, native keyboard scrolling and full trial invariance at '+surface.viewportSize().width);
  };
  const inspectMatrixKeyboard = async surface => {
    const before=await read(surface),scroller=surface.locator('.pr-matrix-scroll');
    await scroller.evaluate(node=>{node.scrollLeft=node.scrollWidth-node.clientWidth;});
    await surface.waitForFunction(()=>document.querySelector('#pr-matrix-scroll-hint').dataset.position==='end');
    const first=Number(await surface.locator('#pr-matrix-scroll-hint').getAttribute('data-first'));
    const receiver=await surface.locator('.matrix-rows g[aria-pressed="true"]').evaluate(node=>node.__data__);
    await surface.locator('.matrix-cell[data-receiver="'+receiver+'"][data-source="'+(first+1)+'"]').focus();
    for(let i=0;i<3;i++){
      await surface.keyboard.press('ArrowLeft');
      const focus=await surface.evaluate(()=>{
        const cell=document.activeElement,box=cell.getBoundingClientRect(),axis=document.querySelector('.matrix-receiver-background').getBoundingClientRect();
        return {source:Number(cell.dataset.source),left:box.left,axisRight:axis.right};
      });
      assert.equal(focus.source,first-i);
      assert.ok(focus.left>=focus.axisRight-.5,'Keyboard inspection keeps the focused source clear of pinned labels');
    }
    assert.deepEqual((await read(surface)).snapshot,before.snapshot,'Keyboard inspection changes no physical state or controller data');
    checks.push('Native cell arrow inspection stays clear of fixed receiver labels at '+surface.viewportSize().width);
  };
  const switchNetwork = async (surface, id) => {
    await surface.locator('#pr-network-scenario').selectOption(id);
    await surface.waitForFunction(id => document.querySelector('#power-response-demo').powerDemo.getSnapshot().networkId === id, id);
    const { snapshot, state } = await read(surface);
    assert.equal(snapshot.initialOptions.networkId, id);
    assert.equal(snapshot.states.online.length, networks[id].buses);
    assert.equal(snapshot.t, 0, 'Switch begins a fresh trial');
    assert.equal(snapshot.phase, 'discovery');
    assert.equal(state.playing, false, 'Changing a model pauses playback');
    assert.deepEqual(state.activeAttackBuses, [], 'Attacks do not cross different plants');
    assert.ok(state.selectedBus >= 1 && state.selectedBus <= networks[id].buses);
    assert.deepEqual(Object.values(snapshot.cumulative), [0, 0, 0, 0]);
    assert.equal(state.historyIndex, null);
    assert.equal(state.inspectedSource, null);
    await checkLayout(surface, id);
    await setting(surface, 'power-scenario', 'solar-outage');
    assert.match(await surface.locator('#pr-scenario-status').textContent(), new RegExp('\\b' + networks[id].solar + ' sites\\b'), 'Solar scenario uses the active network site count');
    assert.equal((await read(surface)).snapshot.networkId, id, 'Scenario changes retain the selected physical model');
    await setting(surface, 'power-scenario', 'forecasted-demand');
  };
  const compare = async (surface, id, carryAttack = false) => {
    await setting(surface, 'speed', '32');
    if (!(await read(surface)).state.playing) await surface.locator('#pr-run').click();
    await surface.waitForFunction(() => document.querySelector('#power-response-demo').powerDemo.getSnapshot().phase === 'deployment', null, { timeout: 120000 });
    if (carryAttack) {
      const { snapshot, state } = await read(surface);
      assert.ok(state.activeAttackBuses.includes(47), 'Largest bus attack survives the automatic phase change');
      assert.ok(snapshot.eventLog.some(item => item.type === 'pulse' && item.bus === 47), 'Transferred attack affects the new comparison');
      await surface.locator('#pr-stop-attacks').click();
    }
    await surface.waitForFunction(() => {
      const demo = document.querySelector('#power-response-demo').powerDemo;
      return demo.getSnapshot().phase === 'deployment' && demo.getSnapshot().t === 180 && !demo.getState().playing;
    }, null, { timeout: 120000 });
    const { snapshot } = await read(surface), expected = networks[id];
    assert.equal(snapshot.networkId, id);
    assert.equal(snapshot.deployedSupport.links.filter(link => link.from !== link.to).length, expected.sparse);
    assert.equal(snapshot.deployedSupport.fixedLinks.filter(link => link.from !== link.to).length, expected.sparse);
    const rows = await surface.locator('#pr-cost-detail tr').evaluateAll(nodes => nodes.map(node => ({
      method: node.dataset.method, links: Number(node.querySelector('.pr-method-links').dataset.links),
      cost: Number(node.querySelector('[data-cost]').dataset.cost)
    })));
    assert.deepEqual(rows.map(row => row.method), ['online', 'scalar', 'static', 'causal']);
    assert.deepEqual(rows.map(row => row.links), [expected.sparse, expected.sparse, expected.dense, 0]);
    for (const row of rows) {
      assert.ok(Number.isFinite(row.cost) && row.cost > 0, 'Every controller has an actual measured comparison cost');
      assert.equal(row.cost, snapshot.cumulative[row.method]);
      assert.equal(snapshot.states[row.method].length, expected.buses);
      assert.ok(snapshot.states[row.method].every(Number.isFinite));
    }
    assert.equal(await surface.locator('#pr-cost path.data-series').count(), 4, 'All four comparison curves remain visible');
    const beforeInspection=JSON.stringify((await read(surface)).snapshot),receiver=snapshot.localChannels[0].to,source=2;
    await surface.locator('.pr-matrix-scroll').evaluate(node=>{node.scrollLeft=0;});
    const cell=surface.locator('.matrix-cell[data-receiver="'+receiver+'"][data-source="'+source+'"]');
    if(surface.viewportSize().width<500)await cell.tap();else await cell.click();
    const observation=await surface.evaluate(()=>{
      const root=document.querySelector('#power-response-demo'),snapshot=root.powerDemo.getSnapshot(),sample=snapshot.lastSample,values=document.querySelector('#pr-forecast-values');
      return {snapshot:JSON.stringify(snapshot),t:sample.t,forecast:sample.forecast[1],forcing:sample.disturbance[1],
        timing:document.querySelector('#pr-forecast-timing').textContent,
        labels:Array.from(values.querySelectorAll('dt')).map(node=>({text:node.textContent,font:parseFloat(getComputedStyle(node).fontSize)})),
        values:Array.from(values.querySelectorAll('dd')).map(node=>({text:node.textContent,font:parseFloat(getComputedStyle(node).fontSize)})),
        units:document.querySelector('#pr-forecast-units').textContent,
        width:innerWidth,overflow:document.documentElement.scrollWidth};
    });
    assert.equal(observation.snapshot,beforeInspection,'Reading a source changes no network trial, support, cost or issued forecast');
    assert.equal(observation.timing,'Source 2 · Issued '+Math.max(0,observation.t-4)+' s · Target '+observation.t+' s · Revealed '+(observation.t+1)+' s');
    assert.deepEqual(observation.values.map(item=>item.text),[observation.forecast,observation.forcing,observation.forecast-observation.forcing].map(value=>(1000*value).toFixed(3)));
    assert.ok(observation.labels.every(item=>item.font>=12)&&observation.values.every(item=>item.font>=16));
    assert.match(observation.units,/forcing, not bus voltage/);assert.ok(observation.overflow<=observation.width+1);
    const preview=await surface.locator('#pr-forecast-observation').screenshot({path:path.join(output,'observation-'+id+'-'+surface.viewportSize().width+'.jpg'),type:'jpeg',quality:85});
    console.log('CLOUD_OBSERVATION_'+id+'_'+surface.viewportSize().width+' '+preview.toString('base64'));
    assert.equal(JSON.stringify((await read(surface)).snapshot),beforeInspection,'Pixel capture is read only');
    checks.push(id+' actual source timing, unchanged revealed values and readable forcing units at '+surface.viewportSize().width);
    results.push({ networkId: id, width: surface.viewportSize().width, costs: snapshot.cumulative, links: rows.map(row => row.links) });
    checks.push(id + ' real automatic handoff and all four comparison costs');
    console.log('Network comparison passed ' + id + ' at ' + surface.viewportSize().width);
  };
  const roundTrip = async (surface, id) => {
    await pause(surface);
    const select = s => ({ networkId: s.networkId, t: s.t, phase: s.phase, initialOptions: s.initialOptions,
      states: s.states, cumulative: s.cumulative, stage: s.stage, eventLog: s.eventLog, deployedSupport: s.deployedSupport });
    const before = select((await read(surface)).snapshot);
    const saved = await surface.evaluate(() => window.openai.widgetState);
    assert.equal(saved.privateContent.networkId, id);
    assert.equal(saved.privateContent.initialOptions.networkId, id);
    await surface.reload({ waitUntil: 'networkidle' });
    assert.equal(await surface.locator('#pr-network-scenario').inputValue(), id);
    assert.deepEqual(select((await read(surface)).snapshot), before, 'Saved ' + id + ' trial replays exactly');
    assert.equal((await read(surface)).state.playing, false);
    await checkLayout(surface, id);
    checks.push(id + ' saved state reload');
  };
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.DEMO_SMOKE_CHANNEL ? { channel: process.env.DEMO_SMOKE_CHANNEL } : {}) });
    const open = async options => {
      const page = await browser.newPage(options);
      page.setDefaultTimeout(30000);
      page.on('pageerror', error => errors.push(error.message));
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
      assert.equal(await page.getByRole('link',{name:'Paper',exact:true}).getAttribute('href'),'index.html');
      await page.locator('#pr-network-scenario').waitFor();
      return page;
    };
    const page = await open({ viewport: { width: 1440, height: 1000 } });
    assert.equal(await page.locator('#pr-network-scenario').inputValue(), 'feeder24');
    assert.deepEqual(await page.locator('#pr-network-scenario option').evaluateAll(nodes => nodes.map(node => node.value)), ['toy8', 'feeder24', 'feeder47']);
    assert.equal(await page.locator('#pr-adaptation').getAttribute('open'), null, 'Network selector is available without opening advanced settings');
    await checkLayout(page, 'feeder24');
    await switchNetwork(page, 'toy8');
    await compare(page, 'toy8');
    await roundTrip(page, 'toy8');
    await page.screenshot({ path: path.join(output, 'toy8-desktop.png'), fullPage: true });

    await switchNetwork(page, 'feeder47');
    await inspectMatrixNavigation(page,true);
    await inspectMatrixKeyboard(page);
    await page.locator('#pr-intervention').selectOption('power');
    await setting(page, 'speed', '32');
    const lastBus = page.locator('#pr-network [data-bus="47"] .pe-hit');
    await lastBus.click();
    await waitSamples(page, 5);
    let reading = await read(page);
    assert.ok(reading.state.activeAttackBuses.includes(47));
    assert.ok(reading.snapshot.eventLog.filter(item => item.type === 'pulse' && item.bus === 47).length >= 4, 'One click generates ongoing attacks');
    await lastBus.click();
    assert.equal((await read(page)).state.activeAttackBuses.includes(47), false);
    await lastBus.click();
    await waitSamples(page, 3);
    assert.ok((await read(page)).state.activeAttackBuses.includes(47), 'The same far bus can be attacked repeatedly');
    await compare(page, 'feeder47', true);
    await roundTrip(page, 'feeder47');
    await inspectMatrixNavigation(page);
    await page.screenshot({ path: path.join(output, 'feeder47-desktop.png'), fullPage: true });
    await page.locator('.pr-network-panel').screenshot({ path: path.join(output, 'feeder47-network-desktop.png') });
    await page.locator('.pr-matrix-panel').screenshot({ path: path.join(output, 'feeder47-matrix-desktop.png') });
    await lastBus.click();
    await waitSamples(page, 2);
    assert.equal((await read(page)).state.playing, true);
    await switchNetwork(page, 'toy8');
    await page.waitForTimeout(150);
    assert.equal((await read(page)).snapshot.t, 0, 'Old playback timer cannot mutate the replacement trial');
    await switchNetwork(page, 'feeder24');
    checks.push('Switching from a running attacked larger network clears old timers and attacks');

    const phone = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await switchNetwork(phone, 'feeder47');
    await inspectMatrixNavigation(phone,true);
    await inspectMatrixKeyboard(phone);
    await phone.locator('#pr-intervention').selectOption('power');
    await setting(phone, 'speed', '32');
    const phoneBus = phone.locator('#pr-network [data-bus="47"] .pe-hit');
    await phoneBus.scrollIntoViewIfNeeded();
    await phoneBus.tap();
    await waitSamples(phone, 4);
    assert.ok((await read(phone)).state.activeAttackBuses.includes(47), 'Touch reaches bus 47 inside its scroller');
    await phoneBus.tap();
    assert.equal((await read(phone)).state.activeAttackBuses.includes(47), false);
    await pause(phone);
    const finalCell = phone.locator('#pr-matrix .matrix-cell[data-source="47"]').last();
    await finalCell.scrollIntoViewIfNeeded();
    await finalCell.tap();
    assert.equal((await read(phone)).state.inspectedSource, 47, 'Touch reaches source 47 inside its matrix scroller');
    await checkLayout(phone, 'feeder47');
    await compare(phone, 'feeder47');
    await roundTrip(phone, 'feeder47');
    await inspectMatrixNavigation(phone);
    await phone.screenshot({ path: path.join(output, 'feeder47-mobile.png'), fullPage: true });
    await phone.locator('.pr-network-panel').screenshot({ path: path.join(output, 'feeder47-network-mobile.png') });
    await phone.locator('.pr-matrix-panel').screenshot({ path: path.join(output, 'feeder47-matrix-mobile.png') });
    await switchNetwork(phone, 'toy8');
    await compare(phone, 'toy8');
    await phone.screenshot({ path: path.join(output, 'toy8-mobile.png'), fullPage: true });
    assert.deepEqual(errors, [], 'No runtime errors during network switches or replay');
    await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify({ passed: true, browser: browser.version(), checks, results, errors }, null, 2));
    console.log('Network browser checks passed');
  } catch (error) {
    if (browser) {
      for (const [index, context] of browser.contexts().entries()) {
        const surface = context.pages().at(-1);
        if (surface) await surface.screenshot({ path: path.join(output, 'failure-' + index + '.png'), fullPage: true }).catch(() => {});
      }
    }
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ passed: false, message: error.message, checks, results, errors }, null, 2));
    throw error;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
