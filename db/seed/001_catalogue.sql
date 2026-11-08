-- Reference data: product and module catalogue.
-- Idempotent. Safe to re-run after adding modules.

INSERT INTO licensing.product_catalogue (product_code, product_name, description) VALUES
  ('hotel', 'Hotel Management ERP', 'Full hotel ERP: front office, housekeeping, finance and 44 modules.'),
  ('restaurant', 'Restaurant Management System', 'Standalone restaurant product with QR ordering, kitchen and delivery.'),
  ('bar', 'Bar Management System', 'Standalone bar product with beverage stock, tabs and events.')
ON CONFLICT (product_code) DO UPDATE
  SET product_name = EXCLUDED.product_name, description = EXCLUDED.description;

-- Explicit inserts (kept separate so product assignment is unambiguous).
INSERT INTO licensing.module_catalogue
  (product_id, module_code, module_name, module_category, description, is_core, display_order)
SELECT p.id, m.module_code, m.module_name, m.module_category, m.description, m.is_core, m.display_order
FROM jsonb_to_recordset($modules$
[
  {"p":"hotel","module_code":"guest_management","module_name":"Guest Management","module_category":"core","description":"Guest profiles, preferences, identity and history.","is_core":true,"display_order":1},
  {"p":"hotel","module_code":"reservations","module_name":"Reservation and Booking Management","module_category":"core","description":"Availability, reservations, rate plans and cancellation.","is_core":true,"display_order":2},
  {"p":"hotel","module_code":"front_office","module_name":"Front Office Operations","module_category":"core","description":"Check-in, check-out, room moves and in-house guest services.","is_core":true,"display_order":3},
  {"p":"hotel","module_code":"housekeeping","module_name":"Housekeeping","module_category":"core","description":"Cleaning tasks, checklists, inspections and room readiness.","is_core":true,"display_order":4},
  {"p":"hotel","module_code":"pos","module_name":"Point of Sale","module_category":"core","description":"Outlet point of sale for ancillary revenue.","is_core":true,"display_order":5},
  {"p":"hotel","module_code":"restaurant_bar","module_name":"Restaurant and Bar Management","module_category":"core","description":"Outlet operations when the hotel runs food and beverage.","is_core":true,"display_order":6},
  {"p":"hotel","module_code":"inventory","module_name":"Inventory and Stock Control","module_category":"core","description":"Stock ledger, stores, issues, transfers and stocktake.","is_core":true,"display_order":7},
  {"p":"hotel","module_code":"cashiering","module_name":"Cashiering and Payment Operations","module_category":"core","description":"Shift cashiering, receipts, refunds and reconciliation.","is_core":true,"display_order":8},
  {"p":"hotel","module_code":"night_audit","module_name":"Night Audit and Daily Business Closure","module_category":"core","description":"Business date control, night audit and exception handling.","is_core":true,"display_order":9},
  {"p":"hotel","module_code":"financial_accounting","module_name":"Financial Accounting","module_category":"back_office","description":"Chart of accounts, journals, ledgers and statements.","is_core":false,"display_order":10},
  {"p":"hotel","module_code":"budget_cost_control","module_name":"Budget and Cost Control","module_category":"back_office","description":"Budgets, variance analysis and cost control.","is_core":false,"display_order":11},
  {"p":"hotel","module_code":"procurement","module_name":"Procurement and Purchasing","module_category":"back_office","description":"Requisitions, purchase orders, receipts and matching.","is_core":false,"display_order":12},
  {"p":"hotel","module_code":"hr","module_name":"Human Resources and Staff Information","module_category":"back_office","description":"Employee records, contracts and staff administration.","is_core":false,"display_order":13},
  {"p":"hotel","module_code":"payroll","module_name":"Payroll Management","module_category":"back_office","description":"Payroll runs, deductions, PAYE and pension.","is_core":false,"display_order":14},
  {"p":"hotel","module_code":"attendance_scheduling","module_name":"Staff Attendance and Duty Scheduling","module_category":"back_office","description":"Attendance, rosters and duty schedules.","is_core":false,"display_order":15},
  {"p":"hotel","module_code":"tax_compliance","module_name":"Tax and Statutory Compliance","module_category":"back_office","description":"Configurable tax rules and statutory reporting.","is_core":false,"display_order":16},
  {"p":"hotel","module_code":"fixed_assets","module_name":"Fixed Assets Management","module_category":"back_office","description":"Asset register, depreciation and disposal.","is_core":false,"display_order":17},
  {"p":"hotel","module_code":"maintenance","module_name":"Maintenance and Engineering","module_category":"back_office","description":"Assets, requests, work orders and preventive maintenance.","is_core":false,"display_order":18},
  {"p":"hotel","module_code":"laundry","module_name":"Laundry Management","module_category":"back_office","description":"Linen movement, laundry cycles and losses.","is_core":false,"display_order":19},
  {"p":"hotel","module_code":"treasury","module_name":"Cash Management and Treasury","module_category":"back_office","description":"Cash positions, banking and treasury operations.","is_core":false,"display_order":20},
  {"p":"hotel","module_code":"contracts","module_name":"Contract and Agreement Management","module_category":"back_office","description":"Contracts, renewals and obligations.","is_core":false,"display_order":21},
  {"p":"hotel","module_code":"insurance","module_name":"Insurance and Risk Management","module_category":"back_office","description":"Policies, claims and risk register.","is_core":false,"display_order":22},
  {"p":"hotel","module_code":"quality_assurance","module_name":"Quality Assurance and Service Standards","module_category":"back_office","description":"Standards, audits and service scores.","is_core":false,"display_order":23},
  {"p":"hotel","module_code":"utilities","module_name":"Utilities and Energy Management","module_category":"back_office","description":"Utility consumption and energy cost control.","is_core":false,"display_order":24},
  {"p":"hotel","module_code":"security_loss_prevention","module_name":"Security and Loss Prevention","module_category":"back_office","description":"Incidents, patrols and loss prevention.","is_core":false,"display_order":25},
  {"p":"hotel","module_code":"documents","module_name":"Document and Compliance Management","module_category":"back_office","description":"Document control, retention and compliance evidence.","is_core":false,"display_order":26},
  {"p":"hotel","module_code":"management_reporting","module_name":"Management Reporting and Business Intelligence","module_category":"back_office","description":"Dashboards, KPIs and management reporting.","is_core":false,"display_order":27},
  {"p":"hotel","module_code":"banquet_events","module_name":"Banquet and Event Management","module_category":"specialized","description":"Event enquiries, function sheets and billing.","is_core":false,"display_order":28},
  {"p":"hotel","module_code":"sales_marketing","module_name":"Sales and Marketing","module_category":"specialized","description":"Accounts, campaigns and sales pipeline.","is_core":false,"display_order":29},
  {"p":"hotel","module_code":"crm","module_name":"Customer Relationship Management","module_category":"specialized","description":"Guest relationships, segments and retention.","is_core":false,"display_order":30},
  {"p":"hotel","module_code":"channel_management","module_name":"Channel and Online Booking Management","module_category":"specialized","description":"Channel mapping, availability and rate parity.","is_core":false,"display_order":31},
  {"p":"hotel","module_code":"revenue_management","module_name":"Revenue Management","module_category":"specialized","description":"Forecasting, dynamic rates and yield.","is_core":false,"display_order":32},
  {"p":"hotel","module_code":"multi_branch","module_name":"Hotel Group and Multi-Branch Management","module_category":"specialized","description":"Group consolidation across branches.","is_core":false,"display_order":33},
  {"p":"hotel","module_code":"guest_self_service","module_name":"Guest Self-Service Portal and Mobile App","module_category":"specialized","description":"Guest portal, requests and mobile check-in.","is_core":false,"display_order":34},
  {"p":"hotel","module_code":"notifications","module_name":"Notifications and Communication","module_category":"specialized","description":"Templated email, SMS and push messaging.","is_core":false,"display_order":35},
  {"p":"hotel","module_code":"integrations","module_name":"Integration and Payment Gateway","module_category":"specialized","description":"Payment providers, channel and external integrations.","is_core":false,"display_order":36},
  {"p":"hotel","module_code":"spa_wellness","module_name":"Spa, Wellness and Recreation","module_category":"specialized","description":"Spa bookings, therapists and recreation facilities.","is_core":false,"display_order":37},
  {"p":"hotel","module_code":"minibar","module_name":"Minibar Management","module_category":"specialized","description":"Minibar stock, consumption and posting.","is_core":false,"display_order":38},
  {"p":"hotel","module_code":"tours_travel","module_name":"Group, Tour and Travel Management","module_category":"specialized","description":"Groups, tours and travel agent handling.","is_core":false,"display_order":39},
  {"p":"hotel","module_code":"central_reservation","module_name":"Central Reservation and Call Centre","module_category":"specialized","description":"Central reservations and call centre workflows.","is_core":false,"display_order":40},
  {"p":"hotel","module_code":"food_safety","module_name":"Food Safety and Kitchen Compliance","module_category":"specialized","description":"HACCP checks, temperature logs and hygiene.","is_core":false,"display_order":41},
  {"p":"hotel","module_code":"guest_credit","module_name":"Guest Credit and Corporate Billing","module_category":"specialized","description":"City ledger, credit limits and corporate accounts.","is_core":false,"display_order":42},
  {"p":"hotel","module_code":"training","module_name":"Staff Training and Learning Management","module_category":"specialized","description":"Courses, certifications and training records.","is_core":false,"display_order":43},
  {"p":"hotel","module_code":"franchise","module_name":"Franchise and Hotel Brand Standards","module_category":"specialized","description":"Brand standards, franchise compliance and audits.","is_core":false,"display_order":44},
  {"p":"restaurant","module_code":"core","module_name":"Restaurant Registration and Configuration","module_category":"core","description":"Outlet setup, branches and operating configuration.","is_core":true,"display_order":1},
  {"p":"restaurant","module_code":"menu_qr","module_name":"Digital Menu and QR Ordering","module_category":"core","description":"Digital menus, QR codes and QR ordering channels.","is_core":true,"display_order":2},
  {"p":"restaurant","module_code":"ordering","module_name":"Ordering and Order Lifecycle","module_category":"core","description":"Dine-in, takeaway, delivery, website and QR orders.","is_core":true,"display_order":3},
  {"p":"restaurant","module_code":"tables","module_name":"Table and Dining Management","module_category":"core","description":"Dining areas, tables, sessions and waitlists.","is_core":true,"display_order":4},
  {"p":"restaurant","module_code":"pos","module_name":"Restaurant POS and Cashiering","module_category":"core","description":"POS sessions, cashiering and receipts.","is_core":true,"display_order":5},
  {"p":"restaurant","module_code":"kitchen","module_name":"Kitchen Operations and KDS","module_category":"core","description":"Kitchen tickets, routing and preparation tracking.","is_core":true,"display_order":6},
  {"p":"restaurant","module_code":"recipes","module_name":"Recipe and Portion Control","module_category":"core","description":"Recipes, ingredients, portion control and food cost.","is_core":true,"display_order":7},
  {"p":"restaurant","module_code":"inventory","module_name":"Restaurant Inventory and Stores","module_category":"core","description":"Store issues, wastage and stock control.","is_core":true,"display_order":8},
  {"p":"restaurant","module_code":"procurement","module_name":"Restaurant Procurement","module_category":"back_office","description":"Suppliers, purchase orders and goods receipts.","is_core":false,"display_order":9},
  {"p":"restaurant","module_code":"customers","module_name":"Customer Management","module_category":"specialized","description":"Customer profiles and order history.","is_core":false,"display_order":10},
  {"p":"restaurant","module_code":"loyalty","module_name":"Loyalty and Promotions","module_category":"specialized","description":"Loyalty points, rewards and promotions.","is_core":false,"display_order":11},
  {"p":"restaurant","module_code":"workforce","module_name":"Restaurant Workforce","module_category":"back_office","description":"Staff, shifts and service assignments.","is_core":false,"display_order":12},
  {"p":"restaurant","module_code":"finance","module_name":"Restaurant Financial Management","module_category":"back_office","description":"Outlet revenue, costs and settlement.","is_core":false,"display_order":13},
  {"p":"restaurant","module_code":"analytics","module_name":"Restaurant Analytics and Reporting","module_category":"specialized","description":"Sales, menu performance and outlet analytics.","is_core":false,"display_order":14},
  {"p":"restaurant","module_code":"delivery","module_name":"Delivery and Dispatch","module_category":"specialized","description":"Delivery orders, dispatch and riders.","is_core":false,"display_order":15},
  {"p":"restaurant","module_code":"reservations","module_name":"Restaurant Reservations and Waitlist","module_category":"specialized","description":"Table reservations, waitlist and seating.","is_core":false,"display_order":16},
  {"p":"restaurant","module_code":"admin","module_name":"Restaurant Administration and Security","module_category":"back_office","description":"Roles, audit and outlet administration.","is_core":false,"display_order":17},
  {"p":"bar","module_code":"core","module_name":"Bar Setup and Configuration","module_category":"core","description":"Bar outlets, operating configuration and licensing.","is_core":true,"display_order":1},
  {"p":"bar","module_code":"beverages","module_name":"Beverage Menu Management","module_category":"core","description":"Beverage catalogue, pricing and availability.","is_core":true,"display_order":2},
  {"p":"bar","module_code":"pos","module_name":"Bar POS","module_category":"core","description":"Bar point of sale, tabs and cashiering.","is_core":true,"display_order":3},
  {"p":"bar","module_code":"orders","module_name":"Bar Orders and Service","module_category":"core","description":"Counter, table, tab and room service orders.","is_core":true,"display_order":4},
  {"p":"bar","module_code":"inventory","module_name":"Beverage Inventory and Stock Control","module_category":"core","description":"Bottle stock, pours, variance and stocktakes.","is_core":true,"display_order":5},
  {"p":"bar","module_code":"recipes","module_name":"Drink and Cocktail Recipes","module_category":"core","description":"Cocktail recipes, costing and pour control.","is_core":true,"display_order":6},
  {"p":"bar","module_code":"customers","module_name":"Bar Customer Management","module_category":"specialized","description":"Customer tabs, history and preferences.","is_core":false,"display_order":7},
  {"p":"bar","module_code":"events","module_name":"Bar Events and Entertainment","module_category":"specialized","description":"Events, tickets and entertainment scheduling.","is_core":false,"display_order":8},
  {"p":"bar","module_code":"finance","module_name":"Bar Financial Management","module_category":"back_office","description":"Revenue, cost of sales and settlement.","is_core":false,"display_order":9},
  {"p":"bar","module_code":"analytics","module_name":"Bar Analytics and Reporting","module_category":"specialized","description":"Sales mix, margin and performance reporting.","is_core":false,"display_order":10},
  {"p":"bar","module_code":"security","module_name":"Bar Security and Internal Controls","module_category":"back_office","description":"Voids, pour variance and internal controls.","is_core":false,"display_order":11}
]
$modules$::jsonb) AS m(
  p text, module_code text, module_name text, module_category text,
  description text, is_core boolean, display_order integer
)
JOIN licensing.product_catalogue p ON p.product_code = m.p
ON CONFLICT (product_id, module_code) DO UPDATE
  SET module_name = EXCLUDED.module_name,
      module_category = EXCLUDED.module_category,
      description = EXCLUDED.description,
      is_core = EXCLUDED.is_core,
      display_order = EXCLUDED.display_order;
