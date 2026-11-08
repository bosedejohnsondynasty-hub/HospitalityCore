// Script to inject into browser to fix the shifts table by:
// 1. Setting the valid auth token
// 2. Directly updating the React fiber state for shiftTo
// 3. Calling the onChange handler to trigger the useEffect

(() => {
  // 1. Set valid token
  localStorage.setItem('hc.token', 'xxmKRQfr9h_XLbHmUk3LpEzaXBeT3DkEquB3_aTAZYU');
  localStorage.removeItem('hc.me');
  console.log('Token set');

  // 2. Find the To date input and its fiber
  const toInput = Array.from(document.querySelectorAll('input[type="date"]')).find(i => 
    i.labels?.[0]?.textContent === 'To');
  
  if (!toInput) {
    console.log('To input not found');
    return;
  }

  const fiber = toInput.__reactFiber$wcqbkysez3r;
  if (!fiber) {
    console.log('Fiber not found');
    return;
  }

  // 3. Walk up to WorkforcePage component
  let wp = fiber;
  for (let i = 0; i < 10; i++) wp = wp.return;
  
  if (!wp || wp.type?.name !== 'WorkforcePage') {
    console.log('WorkforcePage not found, found:', wp?.type?.name);
    return;
  }

  console.log('Found WorkforcePage fiber');

  // 4. Walk hooks to find shiftTo
  // Based on the code, useState order after useAsync/useAction hooks:
  // Hook 0-5: employees useAsync (data, loading, error) x2 (employees + runs)
  // Actually useAsync uses 3 hooks each (data, loading, error) = 6 hooks total for 2 useAsync
  // Then useAction = 3 hooks (busy, error, notice)
  // Then useState calls: fullName, jobTitle, department, hireDate, salary,
  //   periodStart, periodEnd, shiftFrom, shiftTo, shiftEmployee, shiftRole, 
  //   shiftStart, shiftEnd, shiftsData, shiftsLoading = 15 hooks
  // Total = 6 + 3 + 15 = 24 hooks, but we see 30 so there are more

  let hook = wp.memoizedState;
  let idx = 0;
  let shiftToHook = null;
  
  while (hook && idx < 40) {
    const s = hook.memoizedState;
    
    // Find strings that look like dates
    if (typeof s === 'string' && s.startsWith('2026-') && s.length === 10) {
      console.log('Found date at hook[' + idx + ']:', s);
    }
    
    // Look specifically for '2026-11-21' which is the current shiftTo value
    if (s === '2026-11-21') {
      console.log('Found shiftTo (2026-11-21) at hook index', idx);
      shiftToHook = hook;
    }
    
    hook = hook.next;
    idx++;
  }

  if (shiftToHook) {
    // Update the value
    shiftToHook.memoizedState = '2026-11-25';
    console.log('Updated shiftTo to 2026-11-25');
    
    // Also update the DOM
    toInput.value = '2026-11-25';
    toInput.setAttribute('value', '2026-11-25');
    
    // Flag the component fiber for re-render
    wp.flags |= 2; // ShouldTriggerUpdate
    
    // Also call the onChange handler on the input fiber
    if (fiber.memoizedProps?.onChange) {
      fiber.memoizedProps.onChange({ target: { value: '2026-11-25' } });
    }
    
    console.log('Done - should trigger re-render');
  } else {
    console.log('shiftTo (2026-11-21) not found in hooks, searched', idx, 'hooks');
  }
})();
