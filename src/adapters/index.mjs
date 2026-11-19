export {createXhsAdapter,XHS_FANS_PATH} from './xhs.mjs';
export const adapterStatus=Object.freeze({xhs:'live: identity + daily metrics via passive capture (src/adapters/xhs-live.mjs); xhs.mjs contract is not on the live path',douyin:'reserved; not implemented',channels:'reserved; not implemented'});
export function unsupportedAdapter(platform){return {async observeIdentity(){return {verified:false,platform,reason:'只读身份适配未接入'};},async readFollowers(){throw Error('Platform collector not enabled');}};}
