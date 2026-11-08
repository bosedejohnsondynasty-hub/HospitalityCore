-- 017: permission codes may carry deeper action paths, e.g.
--      inventory.stock.adjust.approve. Still fully namespaced, still lowercase.

ALTER TABLE access.permissions DROP CONSTRAINT permissions_code_shape;
ALTER TABLE access.permissions
  ADD CONSTRAINT permissions_code_shape CHECK (permission_code ~ '^[a-z0-9_]+(\.[a-z0-9_]+){2,4}$');
