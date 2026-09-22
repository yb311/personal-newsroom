import { createServer } from 'node:http';

const port=Number(process.env['PNR_MOCK_PORT']??43123);
const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
  const text=JSON.stringify(body);
  const completion=(content:string)=>({id:'mock',object:'chat.completion',created:1,model:'mock',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});
  if(!String(req.url).endsWith('/chat/completions')){res.writeHead(404);res.end();return;}
  if(!body.stream){
    let content='{"ok":true}';
    if(text.includes('Select at most 8')){
      const id=text.match(/\\n([A-Za-z0-9_-]{8,}) \\|/)?.[1]??'';content=JSON.stringify({itemIds:id?[id]:[]});
    }
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(completion(content)));return;
  }
  const answer=JSON.stringify({title:'Mock streamed report',units:[{kind:'paragraph',text:'This answer came through the packaged Electron streaming IPC.',sourceRefIds:['s1'],supported:true}]});
  res.writeHead(200,{'content-type':'text/event-stream'});
  const send=(content:string,finish_reason:null|'stop'=null,usage?:unknown)=>res.write(`data: ${JSON.stringify({id:'mock-stream',object:'chat.completion.chunk',created:1,model:'mock',choices:[{index:0,delta:content?{content}:{},finish_reason}],...(usage?{usage}:{})})}\n\n`);
  send(answer.slice(0,55));
  const timer=setTimeout(()=>{send(answer.slice(55));send('', 'stop',{prompt_tokens:40,completion_tokens:20,total_tokens:60});res.end('data: [DONE]\n\n');},10000);
  req.on('close',()=>clearTimeout(timer));
});
server.listen(port,'127.0.0.1',()=>console.log(`mock-ai:${port}`));
