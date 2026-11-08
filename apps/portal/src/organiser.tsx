import { useEffect, useState, type FormEvent } from "react";
import { parseEligibilityImportWithMetadata } from "./eligibility-import";

type User = {id:string;email:string;isOrganiser:boolean};
type Session = {user:User;csrfToken:string};
type Option = {id:string;label:string};
type Question = {id:string;type:"single_choice"|"rating"|"free_text";prompt:string;required:boolean;options?:Option[]};
type Summary = {id:string;title:string;status:"draft"|"open"|"closed";revision:number;closesAt:string};
type Poll = Summary & {description:string;questions:Question[];eligibilityEmails:string[]|null};
type PublishedQuestion = {questionId:string;state:"published";answeredCount:number;skippedCount:number} & (
  {type:"single_choice";options:{optionId:string;count:number;percentage:number}[]} |
  {type:"rating";mean:number;distribution:{value:number;count:number;percentage:number}[]} |
  {type:"free_text";texts:string[]});
type ResultItem = PublishedQuestion | {questionId:string;state:"withheld";reason:"insufficient_answers"};
type Results = {state:"withheld";reason:"insufficient_responses"} | {state:"ready";totalResponses:number;questions:ResultItem[]};
type ResultsView = {title:string;questions:Question[]} & ({kind:"loaded";results:Results}|{kind:"message";text:string});
const RESULT_GUIDANCE="Results appear only after closure and at least five responses, and each question needs five answers. "+
  "This is a publication threshold, not anonymity: small or unanimous categories, free text, repeated polls and outside "+
  "knowledge can still identify people. Free-text answers are shown in an independent random order, exactly as written.";

/** Plain-text rendering only: every value goes through React's escaping; no HTML, Markdown or links. */
function ResultsPanel({view}:{view:ResultsView}) {
  const prompt=(id:string)=>view.questions.find((question)=>question.id===id);
  return <section aria-label="Results"><h2>Results: {view.title}</h2><p>{RESULT_GUIDANCE}</p>
    {view.kind==="message"?<p>{view.text}</p>:view.results.state==="withheld"?
      <p>Results are permanently withheld: fewer than five responses were received.</p>:
      <><p>{view.results.totalResponses} responses</p>
        {view.results.questions.map((item)=>{
          const question=prompt(item.questionId);
          return <div key={item.questionId}><h3>{question?.prompt??"Question"}</h3>
            {item.state==="withheld"?<p>Withheld: fewer than five answers.</p>:<>
              <p>{item.answeredCount} answered, {item.skippedCount} skipped</p>
              {item.type==="single_choice"&&<ul>{item.options.map((option)=><li key={option.optionId}>
                {question?.options?.find((candidate)=>candidate.id===option.optionId)?.label??"Option"}: {option.count} ({option.percentage}%)</li>)}</ul>}
              {item.type==="rating"&&<><p>Mean {item.mean}</p><ul>{item.distribution.map((entry)=><li key={entry.value}>
                {entry.value}: {entry.count} ({entry.percentage}%)</li>)}</ul></>}
              {item.type==="free_text"&&<ul>{item.texts.map((text,index)=><li key={index} style={{whiteSpace:"pre-wrap"}}>{text}</li>)}</ul>}
            </>}
          </div>;
        })}</>}
  </section>;
}

const blankQuestion=():Question=>({id:crypto.randomUUID(),type:"rating",prompt:"",required:true});
function localDate(instant:Date):string {
  const pad=(value:number)=>String(value).padStart(2,"0");
  return `${instant.getFullYear()}-${pad(instant.getMonth()+1)}-${pad(instant.getDate())}T${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
}
const warnings="Questions are publicly readable to anyone with the link; eligibility does not make them confidential. Free text may identify authors. Fewer than five responses means results are permanently withheld. Opening freezes questions, eligibility, deadline, key and publication policy.";

export function OrganiserApp() {
  const [session,setSession]=useState<Session|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [busy,setBusy]=useState(false);
  const [polls,setPolls]=useState<Summary[]>([]);
  const [active,setActive]=useState<Poll|null>(null);
  const [title,setTitle]=useState("");
  const [description,setDescription]=useState("");
  const [deadline,setDeadline]=useState(()=>localDate(new Date(Date.now()+86400000)));
  const [eligibility,setEligibility]=useState("");
  const [questions,setQuestions]=useState<Question[]>([blankQuestion()]);
  const [preview,setPreview]=useState(false);
  const [results,setResults]=useState<ResultsView|null>(null);

  const refreshSession=async()=>{
    const response=await fetch("/api/v1/session",{credentials:"same-origin",cache:"no-store"});
    if(response.status===401){setSession(null);setLoading(false);return;}
    if(!response.ok) throw new Error("Session unavailable");
    setSession(await response.json() as Session);setLoading(false);
  };
  const refreshPolls=async()=>{
    const response=await fetch("/api/v1/polls?limit=50",{credentials:"same-origin",cache:"no-store"});
    if(!response.ok) throw new Error("Poll list unavailable");
    setPolls((await response.json() as {items:Summary[]}).items);
  };
  useEffect(()=>{void refreshSession().catch(()=>{setError("Session unavailable");setLoading(false);});},[]);
  useEffect(()=>{if(session?.user.isOrganiser) void refreshPolls().catch(()=>setError("Poll list unavailable"));},[session]);
  const mutate=async(path:string,method:"POST"|"PUT"|"DELETE",body:unknown,sourceRows:number[]=[]):Promise<Poll>=>{
    if(!session) throw new Error("Sign in first");
    const response=await fetch(path,{method,credentials:"same-origin",cache:"no-store",
      headers:{"Content-Type":"application/json","X-CSRF-Token":session.csrfToken},body:JSON.stringify(body)});
    if(!response.ok){
      const result=await response.json().catch(()=>({error:{code:"temporarily_unavailable"}})) as
        {error?:{code?:string;rowNumbers?:number[]}};
      const rows=result.error?.rowNumbers;
      throw new Error(`${result.error?.code??"temporarily_unavailable"}${rows?.length?` (rows ${rows.map((row)=>sourceRows[row-1]??row).join(", ")})`:""}`);
    }
    return await response.json() as Poll;
  };
  const perform=async(action:()=>Promise<void>)=>{
    setError("");setNotice("");setBusy(true);
    try {await action();}catch(cause){setError(cause instanceof Error?cause.message:"Operation unavailable");}
    finally{setBusy(false);}
  };
  const login=async(account:string)=>perform(async()=>{
    const response=await fetch("/__demo/login",{method:"POST",credentials:"same-origin",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({account})});
    if(!response.ok) throw new Error("Synthetic demo login unavailable; start the local demo API.");
    await refreshSession();
  });
  const logout=async()=>perform(async()=>{
    const response=await fetch("/api/v1/auth/logout",{method:"POST",credentials:"same-origin",
      headers:{"Content-Type":"application/json","X-CSRF-Token":session!.csrfToken},body:"{}"});
    if(!response.ok) throw new Error("Logout unavailable");
    setSession(null);setActive(null);setPolls([]);
  });
  const reset=()=>{setActive(null);setTitle("");setDescription("");
    setDeadline(localDate(new Date(Date.now()+86400000)));setEligibility("");setQuestions([blankQuestion()]);setPreview(false);setNotice("");};
  const choose=async(id:string)=>perform(async()=>{
    const response=await fetch(`/api/v1/polls/${id}`,{credentials:"same-origin",cache:"no-store"});
    if(!response.ok) throw new Error("Poll unavailable");
    const poll=await response.json() as Poll;
    setActive(poll);setTitle(poll.title);setDescription(poll.description);
    setDeadline(localDate(new Date(poll.closesAt)));
    setEligibility(poll.eligibilityEmails?.join("\n")??"");
    setQuestions(poll.questions);setPreview(false);
  });
  const save=(event:FormEvent)=>{
    event.preventDefault();void perform(async()=>{
      const {emails,sourceRows}=parseEligibilityImportWithMetadata(eligibility);
      const date=new Date(deadline);
      if(!Number.isFinite(date.getTime())) throw new Error("Invalid deadline");
      const draft={title,description,closesAt:date.toISOString(),questions,eligibilityEmails:emails};
      const poll=active?await mutate(`/api/v1/polls/${active.id}`,"PUT",{revision:active.revision,draft},sourceRows):
        await mutate("/api/v1/polls","POST",draft,sourceRows);
      setActive(poll);setNotice(`Draft saved. Revision ${poll.revision}.`);await refreshPolls();
    });
  };
  const transition=(poll:Summary,operation:"open"|"close")=>{
    const prompt=operation==="open"?`${warnings}\n\nOpening is irreversible. Open this poll?`:
      "Closing is irreversible and may permanently withhold results. Close this poll?";
    if(!window.confirm(prompt)) return;
    void perform(async()=>{
      const updated=await mutate(`/api/v1/polls/${poll.id}/${operation}`,"POST",operation==="open"?{revision:poll.revision}:{});
      if(active?.id===poll.id) setActive(updated);
      await refreshPolls();setNotice(`Poll is ${updated.status}.`);
    });
  };
  const viewResults=(poll:Summary)=>void perform(async()=>{
    const owned=await (await fetch(`/api/v1/polls/${poll.id}`,{credentials:"same-origin",cache:"no-store"})).json() as Poll;
    const response=await fetch(`/api/v1/polls/${poll.id}/results`,{credentials:"same-origin",cache:"no-store"});
    const base={title:owned.title,questions:owned.questions};
    if(response.ok) {setResults({...base,kind:"loaded",results:await response.json() as Results});return;}
    const code=(await response.json().catch(()=>({})) as {error?:{code?:string}}).error?.code;
    setResults({...base,kind:"message",text:code==="results_not_closed"?"Results are available only after the poll closes.":
      code==="poll_withdrawn"?"This poll was withdrawn. Its results are permanently withheld.":"Results are unavailable."});
  });
  const updateQuestion=(index:number,change:Partial<Question>)=>setQuestions((current)=>current.map((question,i)=>
    i===index?{...question,...change}:question));

  if(loading) return <main>Checking portal session…</main>;
  if(!session) return <main><h1>Portal sign-in</h1>
    <p>This local synthetic demo does not authenticate real IITGN accounts. It is not ready for participants.</p>
    {import.meta.env.DEV&&<div><button type="button" onClick={()=>void login("organiser")}>Sign in as organiser</button>
      <button type="button" onClick={()=>void login("student1")}>Sign in as synthetic participant</button></div>}
    {error&&<p role="alert">{error}</p>}</main>;
  return <main>
    <h1>Your polls</h1><p>Signed in as {session.user.email} (synthetic local identity).</p>
    {import.meta.env.DEV&&<button type="button" onClick={()=>void logout()}>Sign out of local demo</button>}
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {!session.user.isOrganiser?<p>This account is not provisioned as an organiser.</p>:<>
      <p>{warnings}</p>
      <h2>Owned polls</h2><button type="button" onClick={reset}>New poll</button>
      <ul>{polls.map((poll)=><li key={poll.id}>
        <button type="button" onClick={()=>void choose(poll.id)}>{poll.title}</button> — Poll is {poll.status}.
        {poll.status==="draft"&&<button type="button" disabled={busy} onClick={()=>transition(poll,"open")}>Open poll</button>}
        {poll.status==="open"&&<button type="button" disabled={busy} onClick={()=>transition(poll,"close")}>Close poll</button>}
        {poll.status==="closed"&&<button type="button" disabled={busy} onClick={()=>viewResults(poll)}>View results</button>}
        <a href={`${__RESPOND_ORIGIN__}/p/${poll.id}`} target="_blank" rel="noopener noreferrer">Public poll link</a>
      </li>)}</ul>
      {results&&<ResultsPanel view={results} />}
      <form onSubmit={save}><fieldset disabled={busy}>
        <h2>{active?`Edit ${active.title}`:"Create draft"}</h2>
        <label>Poll title<input value={title} maxLength={480} onChange={(event)=>setTitle(event.target.value)} required /></label>
        <label>Description<textarea value={description} onChange={(event)=>setDescription(event.target.value)} /></label>
        <label>Deadline (local time)<input type="datetime-local" value={deadline} onChange={(event)=>setDeadline(event.target.value)} required /></label>
        <p>Exact UTC deadline: {Number.isFinite(new Date(deadline).getTime())?new Date(deadline).toISOString():"Invalid"}</p>
        <label>Eligibility emails<textarea rows={10} value={eligibility} onChange={(event)=>setEligibility(event.target.value)} required /></label>
        <p>Enter 10–1,000 institutional addresses, one per line or as single-column CSV. Exact list is visible only to the owner.</p>
        <h3>Questions</h3>
        {questions.map((question,index)=><fieldset key={question.id}><legend>Question {index+1}</legend>
          <label>Question {index+1} prompt<input value={question.prompt} onChange={(event)=>updateQuestion(index,{prompt:event.target.value})} required /></label>
          <label>Type<select value={question.type} onChange={(event)=>{
            const type=event.target.value as Question["type"];
            updateQuestion(index,{type,required:type==="free_text"?false:question.required,
              options:type==="single_choice"?(question.options??[{id:crypto.randomUUID(),label:""},{id:crypto.randomUUID(),label:""}]):undefined});
          }}><option value="rating">Rating 1–5</option><option value="single_choice">Single choice</option><option value="free_text">Optional free text</option></select></label>
          {question.type!=="free_text"&&<label>Required<input type="checkbox" checked={question.required}
            onChange={(event)=>updateQuestion(index,{required:event.target.checked})} /></label>}
          {question.type==="single_choice"&&<div>{question.options?.map((option,optionIndex)=><label key={option.id}>
            Option {optionIndex+1}<input value={option.label} onChange={(event)=>updateQuestion(index,{options:question.options?.map((item,i)=>
              i===optionIndex?{...item,label:event.target.value}:item)})} required /></label>)}
            <button type="button" disabled={(question.options?.length??0)>=10} onClick={()=>updateQuestion(index,{options:[...(question.options??[]),{id:crypto.randomUUID(),label:""}]})}>Add option</button></div>}
          <button type="button" disabled={questions.length===1} onClick={()=>setQuestions((current)=>current.filter((_,i)=>i!==index))}>Remove question</button>
        </fieldset>)}
        <button type="button" disabled={questions.length>=20} onClick={()=>setQuestions((current)=>[...current,blankQuestion()])}>Add question</button>
        <button type="button" onClick={()=>setPreview((shown)=>!shown)}>Preview synthetic answers</button>
        {preview&&<section><h3>Synthetic preview</h3><p>Example answers below are invented and never sent to an API.</p>
          <h4>{title||"Untitled poll"}</h4><p>{description}</p>
          {questions.map((question)=><div key={question.id}><p>{question.prompt}</p>
            {question.type==="rating"?<p>Sample rating: 3 (synthetic, not saved)</p>:
              question.type==="single_choice"?<p>Sample choice: {question.options?.[0]?.label||"Option"} (synthetic, not saved)</p>:
              <p>Sample text (synthetic, not saved)</p>}</div>)}
        </section>}
        <button type="submit" disabled={busy||active?.status!==undefined&&active.status!=="draft"}>
          {active?"Save changes":"Save draft"}</button>
      </fieldset></form>
    </>}
  </main>;
}
