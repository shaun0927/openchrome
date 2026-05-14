import type { SchemaProperty } from './schema-validator';
import type { ExtractionFieldPlan } from './plan';

export interface StrategyResult { data: Record<string, unknown>; source: string; fieldsFound: string[]; }

type FieldInput = string[] | ExtractionFieldPlan[];

interface RuntimeFieldPlan {
  field: string;
  aliases: string[];
  selectorTokens: string[];
  expectedType?: string | string[];
}

function normalisePlans(fields: FieldInput): RuntimeFieldPlan[] {
  return fields.map((field) => {
    if (typeof field === 'string') {
      return { field, aliases: [field], selectorTokens: [field] };
    }
    return {
      field: field.field,
      aliases: field.aliases,
      selectorTokens: field.selectorTokens,
      expectedType: field.expectedType,
    };
  });
}

export function buildJsonLdExtractor(fields: FieldInput): string {
  const plans = normalisePlans(fields);
  // val(v, t): project JSON-LD value based on declared schema type.
  // Scalar types attempt common JSON-LD shape projections; object/untyped preserve as-is.
  // IIFE scalar projection keys tried in order: @value, value, ratingValue, name.
  const valFn = `function val(v,t){if(v===null||v===undefined)return v;var st={'string':1,'number':1,'integer':1,'boolean':1};var ts=Array.isArray(t)?t:[t];var isScalar=ts.some(function(x){return st[x]});if(!isScalar)return v;if(typeof v!=='object')return v;var proj=['@value','value','ratingValue','name'];for(var pi=0;pi<proj.length;pi++){if(has(v,proj[pi]))return v[proj[pi]]}return v}`;
  return `(function(fp){var r=Object.create(null);var sc=document.querySelectorAll('script[type="application/ld+json"]');function has(o,k){return !!o&&Object.prototype.hasOwnProperty.call(o,k)}function get(o,k){return has(o,k)?o[k]:undefined}function norm(v){return String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'')}function read(item,keys){for(var a=0;a<keys.length;a++){var key=keys[a];if(has(item,key))return item[key];var nk=norm(key);if(nk){for(var p in item){if(!has(item,p))continue;if(norm(p)===nk)return item[p]}}}return undefined}${valFn}for(var i=0;i<sc.length;i++){try{var d=JSON.parse(sc[i].textContent||'');var g=get(d,'@graph');var it=Array.isArray(d)?d:(g?g:[d]);for(var j=0;j<it.length;j++){var item=it[j];if(!item||typeof item!=='object')continue;for(var k=0;k<fp.length;k++){var f=fp[k];if(has(r,f.field)&&r[f.field]!=null)continue;var keys=f.aliases&&f.aliases.length?f.aliases:[f.field];var v=read(item,keys);var offers=get(item,'offers');if(v===undefined&&offers){var of=Array.isArray(offers)?offers:[offers];for(var o=0;o<of.length;o++){v=read(of[o],keys);if(v!==undefined)break}}if(v!==undefined)r[f.field]=val(v,f.expectedType)}}}catch(e){}}return r})(${JSON.stringify(plans)})`;
}

export function buildMicrodataExtractor(fields: FieldInput): string {
  const plans = normalisePlans(fields);
  return `(function(fp){var r={};for(var i=0;i<fp.length;i++){var f=fp[i];if(r[f.field]!=null)continue;var names=f.aliases&&f.aliases.length?f.aliases:[];for(var p=0;p<names.length;p++){try{var el=document.querySelector('[itemprop="'+names[p]+'"]');if(el){var v=el.getAttribute('content')||el.textContent?.trim()||'';if(v){r[f.field]=v;break}}}catch(e){}}}return r})(${JSON.stringify(plans)})`;
}

export function buildOpenGraphExtractor(fields: FieldInput): string {
  const plans = normalisePlans(fields);
  return `(function(fp){var r={};var mp={'title':['og:title','twitter:title'],'name':['og:title','twitter:title','og:site_name'],'headline':['og:title','twitter:title'],'description':['og:description','twitter:description','description'],'summary':['og:description','twitter:description','description'],'image':['og:image','twitter:image'],'imageurl':['og:image','twitter:image'],'url':['og:url'],'link':['og:url'],'author':['author','article:author'],'publisheddate':['article:published_time','date'],'publishedat':['article:published_time','date'],'date':['article:published_time','date'],'sitename':['og:site_name']};function norm(v){return String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'')}for(var i=0;i<fp.length;i++){var f=fp[i];if(r[f.field]!=null)continue;var cd=[];for(var a=0;a<(f.aliases||[]).length;a++){var alias=f.aliases[a];var key=norm(alias);var mapped=mp[key]||[];cd=cd.concat(mapped);if(cd.indexOf(alias)===-1)cd.push(alias)}for(var c=0;c<cd.length;c++){try{var m=document.querySelector('meta[property="'+cd[c]+'"]')||document.querySelector('meta[name="'+cd[c]+'"]');if(m){var ct=m.getAttribute('content');if(ct){r[f.field]=ct;break}}}catch(e){}}if(!r[f.field]&&(norm(f.field)==='url'||norm(f.field)==='canonical')){var lk=document.querySelector('link[rel="canonical"]');if(lk)r[f.field]=lk.getAttribute('href')}}return r})(${JSON.stringify(plans)})`;
}

export function buildCssHeuristicExtractor(fields: FieldInput, schemaProps: Record<string, SchemaProperty>, scopeSelector?: string): string {
  const plans = normalisePlans(fields);
  return `(function(fp,sp,scope){var r={};var root=scope?document.querySelector(scope):document.body;if(!root)return{};function gt(el){if(!el)return null;if(el.tagName==='IMG')return el.src||el.getAttribute('data-src')||null;return(el.textContent?.trim()||'').slice(0,500)||null}function q1(ss){for(var i=0;i<ss.length;i++){try{var el=root.querySelector(ss[i]);if(el)return el}catch(e){}}return null}function norm(v){return String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'')}for(var i=0;i<fp.length;i++){var f=fp[i];if(r[f.field]!=null)continue;var tokens=f.selectorTokens&&f.selectorTokens.length?f.selectorTokens:[];var ss=[];for(var t=0;t<tokens.length;t++){var raw=tokens[t],fl=raw.toLowerCase(),fk=raw.replace(/([A-Z])/g,'-$1').toLowerCase().replace(/^-/,'');ss.push('[class*="'+fl+'"]','[class*="'+fk+'"]','[data-'+fk+']','[data-testid*="'+fl+'"]','[aria-label*="'+fl+'"]','#'+fl,'#'+fk)}var nf=norm(f.field+' '+tokens.join(' '));var isI=nf.includes('image')||nf.includes('img')||nf.includes('photo')||nf.includes('thumbnail');if(isI)ss.unshift('img[class*="image"]','img[class*="thumb"]','[class*="image"] img','img[class*="product"]','meta[property="og:image"]');if(nf.includes('price')||nf.includes('cost')||nf.includes('amount'))ss.unshift('[class*="price"]','[data-price]','[itemprop="price"]','.price');if(nf.includes('rating')||nf.includes('score'))ss.unshift('[class*="rating"]','[class*="stars"]','[itemprop="ratingValue"]','[aria-label*="rating"]');var el=q1(ss);if(el){if(isI)r[f.field]=el.src||el.getAttribute('data-src')||el.getAttribute('content')||gt(el);else if(el.hasAttribute('content'))r[f.field]=el.getAttribute('content');else{var set=false;for(var t2=0;t2<tokens.length;t2++){var fk2=tokens[t2].replace(/([A-Z])/g,'-$1').toLowerCase().replace(/^-/,'');if(el.hasAttribute('data-'+fk2)){r[f.field]=el.getAttribute('data-'+fk2);set=true;break}}if(!set)r[f.field]=gt(el)}}if(!r[f.field]&&(norm(f.field)==='headline'||norm(f.field)==='title'||norm(f.field)==='name')){var h=root.querySelector('h1,h2,h3');if(h)r[f.field]=(h.textContent?.trim()||'').slice(0,200)}}return r})(${JSON.stringify(plans)},${JSON.stringify(schemaProps)},${JSON.stringify(scopeSelector||null)})`;
}

export function buildMultipleItemExtractor(fields: FieldInput, schemaProps: Record<string, SchemaProperty>, scopeSelector?: string): string {
  const plans = normalisePlans(fields);
  return `(function(fp,sp,scope){var root=scope?document.querySelector(scope):document.body;if(!root)return[];function gt(el){if(!el)return null;if(el.tagName==='IMG')return el.src||el.getAttribute('data-src')||null;return(el.textContent?.trim()||'').slice(0,500)||null}function norm(v){return String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'')}var cs=['[role="list"]','[class*="list"]','[class*="grid"]','[class*="results"]','[class*="items"]','[class*="products"]','[class*="cards"]','table tbody','ul','ol'];var items=[];for(var c=0;c<cs.length;c++){try{var cd=root.querySelector(cs[c]);if(!cd)continue;var ch=cd.children;if(ch.length<2)continue;var ft=ch[0].tagName,sc=0;for(var x=0;x<ch.length;x++)if(ch[x].tagName===ft)sc++;if(sc/ch.length>0.7){for(var y=0;y<Math.min(ch.length,50);y++)items.push(ch[y]);break}}catch(e){}}if(!items.length){var rows=root.querySelectorAll('tr');if(rows.length>1)for(var r=1;r<Math.min(rows.length,51);r++)items.push(rows[r])}if(!items.length)return[];var res=[];for(var i=0;i<items.length;i++){var it=items[i],ext={},has=false;for(var f2=0;f2<fp.length;f2++){var f=fp[f2],nf=norm(f.field+' '+(f.selectorTokens||[]).join(' '));var isI=nf.includes('image')||nf.includes('img')||nf.includes('photo');var isL=nf.includes('url')||nf.includes('link')||nf.includes('href');var v=null;if(isI){var img=it.querySelector('img');if(img)v=img.src||img.getAttribute('data-src')}else if(isL){var a=it.querySelector('a[href]');if(a)v=a.href}else{var tokens=f.selectorTokens&&f.selectorTokens.length?f.selectorTokens:[];for(var t=0;t<tokens.length&&!v;t++){var raw=tokens[t],fl=raw.toLowerCase(),fk=raw.replace(/([A-Z])/g,'-$1').toLowerCase().replace(/^-/,'');var ss=['[class*="'+fl+'"]','[class*="'+fk+'"]','[itemprop="'+fl+'"]','[data-testid*="'+fl+'"]'];for(var s=0;s<ss.length;s++){try{var el=it.querySelector(ss[s]);if(el){v=gt(el);break}}catch(e){}}}}if(!v){if(nf.includes('title')||nf.includes('name')||nf.includes('headline')){var h=it.querySelector('h1,h2,h3,h4,a');if(h)v=(h.textContent?.trim()||'').slice(0,200)}else if(nf.includes('price')||nf.includes('amount')){var pe=it.querySelector('[class*="price"],[data-price],[itemprop="price"]');if(pe)v=gt(pe)}else if(nf.includes('description')||nf.includes('snippet')||nf.includes('summary')){var de=it.querySelector('p,[class*="desc"],[class*="snippet"]');if(de)v=gt(de)}}ext[f.field]=v;if(v!==null)has=true}if(has)res.push(ext)}return res})(${JSON.stringify(plans)},${JSON.stringify(schemaProps)},${JSON.stringify(scopeSelector||null)})`;
}

export function buildStandardDomExtractor(
  fieldNames: string[],
  schemaProps: Record<string, SchemaProperty>,
  scopeSelector: string | undefined,
  maxNodes: number
): string {
  return `(function(fn,sp,scope,maxNodes){var r={};var root=scope?document.querySelector(scope):document.body;if(!root)return{};function clean(v,cap){return (v||'').replace(/\\s+/g,' ').trim().slice(0,cap||500)}function text(el){if(!el)return'';if(el.tagName==='IMG')return el.src||el.getAttribute('data-src')||'';return clean(el.getAttribute('content')||el.getAttribute('aria-label')||el.getAttribute('title')||el.textContent||'',500)}function norm(v){return clean(String(v||'').toLowerCase().replace(/[_-]+/g,' '),200)}function labelFor(f){var fl=norm(f);var words=fl.split(' ').filter(Boolean);var out=[fl];if(words.length>1)out.push(words.join(''));return out}function set(f,v){if(r[f]!=null)return;if(v!==null&&v!==undefined&&clean(String(v),500)!=='')r[f]=clean(String(v),500)}var nodes=Array.prototype.slice.call(root.querySelectorAll('label,dt,th,strong,b,h1,h2,h3,h4,h5,h6,[aria-label],[title],[data-testid],[class],[id],p,li,td,div,span'),0,Math.max(0,maxNodes||2000));for(var i=0;i<fn.length;i++){var f=fn[i];if(r[f]!=null)continue;var aliases=labelFor(f);for(var n=0;n<nodes.length;n++){var el=nodes[n];var hay=norm([el.getAttribute('aria-label'),el.getAttribute('title'),el.getAttribute('data-testid'),el.getAttribute('class'),el.id,el.textContent].filter(Boolean).join(' '));var hit=false;for(var a=0;a<aliases.length;a++){if(aliases[a]&&hay.indexOf(aliases[a])!==-1){hit=true;break}}if(!hit)continue;var v='';if(el.matches&&el.matches('input,textarea,select'))v=el.value||el.getAttribute('value')||el.getAttribute('placeholder')||'';if(!v&&el.tagName==='LABEL'){var control=el.control;if(control)v=control.value||control.getAttribute('value')||control.getAttribute('placeholder')||''}if(!v){var next=el.nextElementSibling;if(next)v=text(next)}if(!v&&el.parentElement){var candidate=el.parentElement.querySelector('input,textarea,select,[data-value],[content]');if(candidate)v=candidate.value||candidate.getAttribute('data-value')||candidate.getAttribute('content')||text(candidate)}if(!v)v=text(el);set(f,v);break}}return r})(${JSON.stringify(fieldNames)},${JSON.stringify(schemaProps)},${JSON.stringify(scopeSelector||null)},${JSON.stringify(maxNodes)})`;
}
