import test from 'node:test';
import assert from 'node:assert/strict';
import * as driver from './native-ui-driver.mjs';

const until=async(_description,predicate)=>{
    for(let sample=0;sample<8;sample++){const result=await predicate();if(result){return result;}}
    throw new Error('Controlled renderer deadline');
};

test('Quick Diff waits for hover layout before one real action click',async()=>{
    assert.equal(typeof driver.clickStableQuickDiffAction,'function');
    let point={x:100,y:60},awaitedFrame=false;
    const pressed=[],released=[];
    const cdp={send:async(method,params)=>{
        if(method==='Runtime.evaluate'&&params.awaitPromise){awaitedFrame=true;point={x:100,y:90};}
        if(method==='Input.dispatchMouseEvent'&&params.type==='mousePressed'){
            assert.equal(awaitedFrame,true);assert.deepEqual({x:params.x,y:params.y},point);pressed.push(params);
        }
        if(method==='Input.dispatchMouseEvent'&&params.type==='mouseReleased'){released.push(params);}
    }};
    const inspect=async()=>({quickDiff:[{provider:'Code Diff Tracker Review'}],actionPoint:{...point}});
    const before=await driver.clickStableQuickDiffAction(cdp,inspect,until);
    assert.deepEqual(before.actionPoint,{x:100,y:90});
    assert.equal(pressed.length,1);assert.equal(released.length,1);
});

test('Quick Diff never clicks another provider or retries an uncertain press',async()=>{
    assert.equal(typeof driver.clickStableQuickDiffAction,'function');
    let presses=0;
    const cdp={send:async(method,params)=>{
        if(method==='Input.dispatchMouseEvent'&&params.type==='mousePressed'){presses++;throw new Error('Unknown press acknowledgement');}
    }};
    await assert.rejects(driver.clickStableQuickDiffAction(cdp,async()=>({
        quickDiff:[{provider:'Git local working changes'}],actionPoint:{x:100,y:90}
    }),until),/Controlled renderer deadline/);
    assert.equal(presses,0);
    await assert.rejects(driver.clickStableQuickDiffAction(cdp,async()=>({
        quickDiff:[{provider:'Code Diff Tracker Review'}],actionPoint:{x:100,y:90}
    }),until),/Unknown press acknowledgement/);
    assert.equal(presses,1);
});
