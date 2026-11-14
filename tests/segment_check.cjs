// Check actual server-produced JavaScript, imported text and the TTS request payloads.
const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {script, cases} = JSON.parse(fs.readFileSync(0, 'utf8'));
const nodes = new Map();
const node = () => ({value: '', style: {}, children: [], classList: {add(){}, remove(){}, toggle(){}},
    addEventListener(){}, scrollIntoView(){}, appendChild(child){this.children.push(child);}});
const sent=[];
const context=vm.createContext({window:{}, location:{search:""}, URLSearchParams, performance, document:{
    getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},
    createElement:node, querySelectorAll:()=>[]},
    Audio:class {pause(){} removeAttribute(){} load(){}},
    AbortController, DOMException, FormData, URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},
    setTimeout,clearTimeout,fetch:async(url,options)=>{
        assert.equal(url,'/tts');sent.push(options.body.get('text'));
        return {ok:true,blob:async()=>({size:10})};
    }});
vm.runInContext(script,context);
context.document.getElementById('voiceSelect').value='pl-PL-ZofiaNeural';
context.document.getElementById('rateSlider').value='0';
(async()=>{
    for(const item of cases){
        context.input=item.text;context.hints=item.blocks||[];
        vm.runInContext('renderSentences(input, hints)',context);
        const segments=Array.from(vm.runInContext('sentences',context));
        assert.deepEqual(segments,item.expected,item.name);
        const displayed=Array.from(context.document.getElementById('readerView').children).slice(-segments.length);
        assert.deepEqual(displayed.map(element=>element.innerText.replace(/\s+/gu,' ').trim()),segments,`${item.name}: display matches TTS`);
        assert.equal(segments.join(' '),item.text.replace(/\s+/gu,' ').trim(),`${item.name}: lossless content/order`);
        assert.ok(!segments.some(text=>/^\d+\.$/.test(text)),`${item.name}: standalone label`);
        sent.length=0;
        for(let idx=0;idx<segments.length;idx++)await vm.runInContext(`currentIdx=${idx}; fetchAudioBlob(${idx})`,context);
        assert.deepEqual(sent,item.expected,`${item.name}: exact /tts payloads`);
        console.log(`PASS: ${item.name}, ${segments.length} fragments, exact content and TTS payloads`);
    }
})().catch(error=>{console.error(error);process.exitCode=1;});
