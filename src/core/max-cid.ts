// One owner process shares a monotonic CID clock across text, media and accounts.
let last=0;
export function nextMaxCid(){last=Math.max(Date.now(),last+1);return last;}
