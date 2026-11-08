// This script will be loaded by the browser to fix the shifts table
// It patches the WorkforcePage component's state directly via React fiber

window.__fixShifts = function() {
  // Find the "To" date input
  const inputs = document.querySelectorAll('input[type="date"]');
  let toInput = null;
  inputs.forEach(inp => {
    if (inp.labels && inp.labels[0] && inp.labels[0].textContent === 'To') {
      toInput = inp;
    }
  });
  if (!toInput) return { ok: false, msg: 'To input not found' };

  const fiber = toInput.__reactFiber$wcqbkysez3r;
  if (!fiber) return { ok: false, msg: 'no fiber' };

  // Walk up to WorkforcePage
  let current = fiber;
  for (let i = 0; i < 10; i++) current = current && current.return;
  if (!current || current.type.name !== 'WorkforcePage') {
    return { ok: false, msg: 'WorkforcePage not found, got ' + (current ? current.type.name : 'null') };
  }

  // Walk the hooks to find shiftTo (index 18) and call its setter
  let hook = current.memoizedState;
  let idx = 0;
  while (hook && idx < 30) {
    if (idx === 18) {
      // This is shiftTo - the memoizedState is the current value
      // The setter is dispatched via the fiber's update queue
      // In React 19, we can trigger an update by creating an update on the fiber
      const currentState = hook.memoizedState;
      console.log('Found shiftTo at index 18, current value:', currentState);

      // Create a React update to set shiftTo to '2026-11-25'
      // In React's internal model, we need to schedule an update on this hook
      // The simplest way: use the fiber's update queue
      if (hook.queue) {
        // Create an update
        const update = {
          tag: 0, // UpdateState
          payload: '2026-11-25',
          next: null,
        };
        // Append to queue
        if (hook.queue.last) {
          hook.queue.last.next = update;
        } else {
          hook.queue.push = update; // fallback
        }
        hook.queue.last = update;

        // Force a re-render by setting the fiber's update flag
        const fiber2 = current;
        fiber2.flags |= 4096; // Placement | Update flags

        console.log('Scheduled update for shiftTo');
      }
      break;
    }
    hook = hook.next;
    idx++;
  }

  // Also update shiftFrom 
  hook = current.memoizedState;
  idx = 0;
  while (hook && idx < 30) {
    if (idx === 17) {
      console.log('Found shiftFrom at index 17, current value:', hook.memoizedState);
      break;
    }
    hook = hook.next;
    idx++;
  }

  return { ok: true, shiftFromIdx: 17, shiftToIdx: 18 };
};
