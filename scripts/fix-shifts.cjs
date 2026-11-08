// Fix shifts table: set valid token and update React state
const script = `
(() => {
  // 1. Set the valid auth token
  localStorage.setItem('hc.token', 'xxmKRQfr9h_XLbHmUk3LpEzaXBeT3DkEquB3_aTAZYU');
  localStorage.removeItem('hc.me');
  
  // 2. Find the WorkforcePage fiber and update shiftTo state
  const inputs = document.querySelectorAll('input[type="date"]');
  let toInput = null;
  inputs.forEach(inp => {
    if (inp.labels && inp.labels[0] && inp.labels[0].textContent === 'To') toInput = inp;
  });
  
  if (toInput) {
    const fiber = toInput.__reactFiber$wcqbkysez3r;
    if (fiber) {
      let wp = fiber;
      for (let i = 0; i < 10; i++) wp = wp && wp.return;
      
      if (wp && wp.type && wp.type.name === 'WorkforcePage' && wp.memoizedState) {
        let hook = wp.memoizedState;
        let idx = 0;
        while (hook && idx < 30) {
          if (idx === 18) { // shiftTo
            hook.memoizedState = '2026-11-25';
          }
          if (idx === 17) { // shiftFrom
            // keep as is
          }
          hook = hook.next;
          idx++;
        }
        console.log('Updated WorkforcePage shiftTo state via fiber');
      }
    }
    
    // Also update the DOM
    toInput.value = '2026-11-25';
    toInput.setAttribute('value', '2026-11-25');
  }
  
  // 3. Call onChange on both inputs to trigger the useEffect
  inputs.forEach(inp => {
    if (inp.labels && inp.labels[0]) {
      const fiber2 = inp.__reactFiber$wcqbkysez3r;
      if (fiber2 && fiber2.memoizedProps && fiber2.memoizedProps.onChange) {
        if (inp.labels[0].textContent === 'To') {
          fiber2.memoizedProps.onChange({ target: { value: '2026-11-25' } });
        }
        if (inp.labels[0].textContent === 'From') {
          fiber2.memoizedProps.onChange({ target: { value: '2026-10-31' } });
        }
      }
    }
  });
  
  // 4. Force a re-render by reloading - the token is now valid
  // But first check if shifts data is already showing
  const p = document.querySelector('p.empty');
  if (p && p.textContent.includes('No shifts')) {
    // Date range is wrong, need to change it
    console.log('Shifts table still empty, needing date update');
  }
})();
`;

// Inject and run
const scriptEl = document.createElement('script');
scriptEl.textContent = script;
(document.head || document.documentElement).appendChild(scriptEl);
