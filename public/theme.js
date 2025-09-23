// Add smooth scroll and Material 5 micro-interactions
document.querySelectorAll("a").forEach(a=>{
  a.addEventListener("click",e=>{
    if(a.href && a.getAttribute("href")[0]==='/'){
      setTimeout(()=>window.scrollTo({top:0,behavior:"smooth"}),22);
    }
  });
});
