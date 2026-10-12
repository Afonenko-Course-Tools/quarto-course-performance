export interface BenchmarkComparison {medianRatio:number;interval95:[number,number];status:"PASS"|"FAIL"|"INCONCLUSIVE";pairs:number}
function median(values:number[]) {const sorted=values.toSorted((a,b)=>a-b), n=sorted.length;return n%2?sorted[(n-1)/2]:(sorted[n/2-1]+sorted[n/2])/2;}
export function compareBenchmarks(ratios:number[],seed:number):BenchmarkComparison {
  if(!ratios.length || ratios.some(r=>!Number.isFinite(r)||r<=0)) throw new Error("Недопустимые benchmark ratios");
  let state=seed>>>0;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  const boot=[];for(let i=0;i<10000;i++)boot.push(median(ratios.map(()=>ratios[Math.floor(random()*ratios.length)])));
  boot.sort((a,b)=>a-b);const interval95:[number,number]=[boot[249],boot[9750]];
  return {medianRatio:median(ratios),interval95,status:interval95[1]<=1.01?"PASS":interval95[0]>1.01?"FAIL":"INCONCLUSIVE",pairs:ratios.length};
}
