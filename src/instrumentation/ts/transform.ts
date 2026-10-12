import ts from "npm:typescript@5.9.3";
export interface SymbolReceipt {id:string;path:string;start:number;end:number;manuallyWrapped:boolean}
export interface InstrumentedModule {source:string;symbols:SymbolReceipt[];skipped:{position:number;reason:string}[]}
export function instrumentModule(source:string,path:string,scope:{strict:boolean;bridgeUrl?:string}):InstrumentedModule {
  const file=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),symbols:SymbolReceipt[]=[],skipped:{position:number;reason:string}[]=[],insertions:{pos:number;text:string}[]=[];
  if((file as ts.SourceFile & {parseDiagnostics: readonly ts.Diagnostic[]}).parseDiagnostics.length)throw new Error("Ошибка разбора TypeScript");
  const manuallyWrapped=new Set<string>();
  function findManual(node:ts.Node) {
    if(ts.isBinaryExpression(node)&&ts.isIdentifier(node.left)&&ts.isCallExpression(node.right)&&ts.isPropertyAccessExpression(node.right.expression)&&/^wrap(Sync|Async|Walk)$/.test(node.right.expression.name.text))manuallyWrapped.add(node.left.text);
    ts.forEachChild(node,findManual);
  }findManual(file);
  function walk(node:ts.Node) {
    if(ts.isConstructorDeclaration(node)||ts.isGetAccessorDeclaration(node)||ts.isSetAccessorDeclaration(node))skipped.push({position:node.getStart(file),reason:"Конструктор или accessor не поддержан"});
    else if(ts.isFunctionDeclaration(node)||ts.isFunctionExpression(node)||ts.isArrowFunction(node)||ts.isMethodDeclaration(node)) {
      if(!node.body) return;
      if(node.asteriskToken || node.modifiers?.some(m=>m.kind===ts.SyntaxKind.Decorator))skipped.push({position:node.getStart(file),reason:"Generator или decorator не поддержан"});
      else if(/\beval\s*\(/.test(node.body.getText(file)))skipped.push({position:node.getStart(file),reason:"Direct eval изменяет scope"});
      else {
        const start=node.getStart(file),end=node.end,id=`${path}:${start}:${end}`;
        const name=node.name?.getText(file),manual=!!name&&manuallyWrapped.has(name);symbols.push({id,path,start,end,manuallyWrapped:manual});
        if(!manual) {
          const async=node.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword),call=`__coursePerf.wrap${async?"Async":"Sync"}(${JSON.stringify({id,kind:"function",origin:"auto",symbol_id:id})}, ${async?"async ":""}() => `;
          if(ts.isBlock(node.body)) {
            insertions.push({pos:node.body.getStart(file)+1,text:`return ${call}{`},{pos:node.body.end-1,text:"})();"});
          } else insertions.push({pos:node.body.getStart(file),text:`${call}(`},{pos:node.body.end,text:"))()"});
        }
      }
    }
    ts.forEachChild(node,walk);
  }walk(file);
  if(scope.strict&&skipped.length)throw new Error(`Неполное coverage: ${JSON.stringify(skipped)}`);
  let result=source;
  for(const edit of insertions.sort((a,b)=>b.pos-a.pos))result=result.slice(0,edit.pos)+edit.text+result.slice(edit.pos);
  if(insertions.length){const offset=result.startsWith("#!")?result.indexOf("\n")+1:0;result=result.slice(0,offset)+`import {createMetrics as __createCoursePerf} from ${JSON.stringify(scope.bridgeUrl??"../../observability/bridge.ts")};\nconst __coursePerf=__createCoursePerf('auto');\n`+result.slice(offset);}
  return {source:result,symbols,skipped};
}
