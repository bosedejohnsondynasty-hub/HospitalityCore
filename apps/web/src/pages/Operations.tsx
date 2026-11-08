import { useEffect, useMemo, useState } from 'react';
import { api, formatDate, type Row } from '../api.js';
import { Button, Card, Field, FormRow, Input, Notice, Select, Table, Tabs, useAction, useAsync } from '../components.js';

type FieldType = 'text' | 'number' | 'date' | 'datetime' | 'select';

interface FieldSpec {
  name: string;
  label: string;
  type?: FieldType;
  options?: Array<{ value: string; label: string }>;
  source?: 'hotels' | 'outlets' | 'bars' | 'accounts' | 'roomTypes';
  placeholder?: string;
  hint?: string;
}

interface ResourceSpec {
  key: string;
  label: string;
  section: SectionKey;
  listPath: string;
  listKey: string;
  createPath: string;
  fields: FieldSpec[];
  compose?: (values: Record<string, string>) => Record<string, unknown> | null;
}

type SectionKey = 'backoffice' | 'guestops' | 'outlets';

const SECTIONS: Array<{ key: SectionKey; label: string }> = [
  { key: 'backoffice', label: 'Back office' },
  { key: 'guestops', label: 'Guest and commercial' },
  { key: 'outlets', label: 'Outlets' },
];

const MODULE_HINTS: Record<string, string> = {
  budgets: 'Budget and cost control',
  transfers: 'Cash management and treasury',
  laundry: 'Laundry management',
  agreements: 'Contract and agreement management',
  policies: 'Insurance and risk management',
  inspections: 'Quality assurance and service standards',
  meters: 'Utilities and energy management',
  incidents: 'Security and loss prevention',
  documents: 'Document and compliance management',
  courses: 'Staff training and learning management',
  banquets: 'Banquet and event management',
  campaigns: 'Sales and marketing',
  interactions: 'Customer relationship management',
  channels: 'Channel and online booking management',
  forecasts: 'Revenue management',
  spaResources: 'Spa, wellness and recreation',
  spaBookings: 'Spa bookings',
  tours: 'Group, tour and travel management',
  callcentre: 'Central reservation and call centre',
  foodSafety: 'Food safety and kitchen compliance',
  corporate: 'Guest credit and corporate billing',
  franchise: 'Franchise and brand standards',
  restaurantReservations: 'Restaurant reservations and waitlist',
  waitlist: 'Waitlist and seating',
  customers: 'Customer management',
  promotions: 'Loyalty and promotions',
  barEvents: 'Bar events and entertainment',
};

const yesNo = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

const RESOURCES: ResourceSpec[] = [
  {
    key: 'budgets',
    label: 'Budgets',
    section: 'backoffice',
    listPath: '/api/v1/hotel/budgets',
    listKey: 'budgets',
    createPath: '/api/v1/hotel/budgets',
    fields: [
      { name: 'name', label: 'Budget name', placeholder: 'Housekeeping payroll 2026' },
      { name: 'fiscalYear', label: 'Fiscal year', type: 'number', placeholder: '2026' },
      { name: 'accountId', label: 'Ledger account', type: 'select', source: 'accounts' },
      { name: 'category', label: 'Category', placeholder: 'payroll' },
      { name: 'amount', label: 'Line amount', type: 'number', placeholder: '1000000' },
    ],
    compose: (values) =>
      values.accountId && values.category && values.amount
        ? {
            lines: [
              {
                accountId: values.accountId,
                category: values.category,
                amount: Number(values.amount),
              },
            ],
          }
        : null,
  },
  {
    key: 'transfers',
    label: 'Treasury',
    section: 'backoffice',
    listPath: '/api/v1/hotel/treasury/transfers',
    listKey: 'transfers',
    createPath: '/api/v1/hotel/treasury/transfers',
    fields: [
      { name: 'sourceBankAccountId', label: 'Source bank account id' },
      { name: 'destinationBankAccountId', label: 'Destination bank account id' },
      { name: 'amount', label: 'Amount', type: 'number' },
      { name: 'reference', label: 'Reference', placeholder: 'TRF-2026-001' },
      { name: 'reason', label: 'Reason' },
    ],
  },
  {
    key: 'laundry',
    label: 'Laundry',
    section: 'backoffice',
    listPath: '/api/v1/hotel/laundry',
    listKey: 'cycles',
    createPath: '/api/v1/hotel/laundry',
    fields: [
      {
        name: 'cycleType',
        label: 'Cycle type',
        type: 'select',
        options: [
          { value: 'guest_linen', label: 'Guest linen' },
          { value: 'restaurant_linen', label: 'Restaurant linen' },
          { value: 'uniforms', label: 'Uniforms' },
        ],
      },
      { name: 'scheduledAt', label: 'Scheduled', type: 'datetime' },
      { name: 'itemName', label: 'Item', placeholder: 'Bath towel' },
      { name: 'quantity', label: 'Quantity', type: 'number', placeholder: '40' },
    ],
    compose: (values) =>
      values.itemName && values.quantity
        ? { items: [{ itemName: values.itemName, quantity: Number(values.quantity) }] }
        : null,
  },
  {
    key: 'agreements',
    label: 'Agreements',
    section: 'backoffice',
    listPath: '/api/v1/hotel/agreements',
    listKey: 'agreements',
    createPath: '/api/v1/hotel/agreements',
    fields: [
      { name: 'agreementName', label: 'Agreement', placeholder: 'Linen supply agreement' },
      { name: 'agreementType', label: 'Type', placeholder: 'supply' },
      { name: 'counterparty', label: 'Counterparty' },
      { name: 'startDate', label: 'Start', type: 'date' },
      { name: 'endDate', label: 'End', type: 'date' },
      { name: 'amount', label: 'Value', type: 'number' },
    ],
  },
  {
    key: 'policies',
    label: 'Insurance',
    section: 'backoffice',
    listPath: '/api/v1/hotel/insurance/policies',
    listKey: 'policies',
    createPath: '/api/v1/hotel/insurance/policies',
    fields: [
      { name: 'insurer', label: 'Insurer' },
      { name: 'policyNumber', label: 'Policy number' },
      { name: 'coverageType', label: 'Coverage', placeholder: 'fire' },
      { name: 'startDate', label: 'Start', type: 'date' },
      { name: 'endDate', label: 'End', type: 'date' },
      { name: 'premium', label: 'Premium', type: 'number' },
      { name: 'deductible', label: 'Deductible', type: 'number' },
    ],
  },
  {
    key: 'inspections',
    label: 'Quality',
    section: 'backoffice',
    listPath: '/api/v1/hotel/quality/inspections',
    listKey: 'inspections',
    createPath: '/api/v1/hotel/quality/inspections',
    fields: [
      { name: 'areaName', label: 'Area', placeholder: 'Room 101' },
      { name: 'standardName', label: 'Standard', placeholder: 'Guest room readiness' },
      { name: 'scheduledAt', label: 'Scheduled', type: 'datetime' },
      { name: 'notes', label: 'Notes' },
    ],
  },
  {
    key: 'meters',
    label: 'Utilities',
    section: 'backoffice',
    listPath: '/api/v1/hotel/utilities/meters',
    listKey: 'meters',
    createPath: '/api/v1/hotel/utilities/meters',
    fields: [
      { name: 'meterName', label: 'Meter', placeholder: 'Main electricity' },
      { name: 'utilityType', label: 'Utility', placeholder: 'electricity' },
      { name: 'unit', label: 'Unit', placeholder: 'kWh' },
      { name: 'location', label: 'Location' },
    ],
  },
  {
    key: 'incidents',
    label: 'Security',
    section: 'backoffice',
    listPath: '/api/v1/hotel/security/incidents',
    listKey: 'incidents',
    createPath: '/api/v1/hotel/security/incidents',
    fields: [
      { name: 'incidentType', label: 'Type', placeholder: 'theft' },
      {
        name: 'severity',
        label: 'Severity',
        type: 'select',
        options: ['low', 'medium', 'high', 'critical'].map((value) => ({ value, label: value })),
      },
      { name: 'occurredAt', label: 'Occurred', type: 'datetime' },
      { name: 'location', label: 'Location' },
      { name: 'description', label: 'Description' },
    ],
  },
  {
    key: 'documents',
    label: 'Documents',
    section: 'backoffice',
    listPath: '/api/v1/hotel/documents',
    listKey: 'documents',
    createPath: '/api/v1/hotel/documents',
    fields: [
      { name: 'documentName', label: 'Document', placeholder: 'Fire safety certificate' },
      { name: 'documentCategory', label: 'Category', placeholder: 'statutory' },
      { name: 'ownerName', label: 'Owner' },
      { name: 'reviewDate', label: 'Review date', type: 'date' },
    ],
  },
  {
    key: 'courses',
    label: 'Training',
    section: 'backoffice',
    listPath: '/api/v1/hotel/training/courses',
    listKey: 'courses',
    createPath: '/api/v1/hotel/training/courses',
    fields: [
      { name: 'courseName', label: 'Course', placeholder: 'Fire warden induction' },
      { name: 'category', label: 'Category', placeholder: 'safety' },
      { name: 'validityDays', label: 'Valid for (days)', type: 'number', placeholder: '365' },
      { name: 'mandatory', label: 'Mandatory', type: 'select', options: yesNo },
    ],
  },
  {
    key: 'banquets',
    label: 'Banquets',
    section: 'guestops',
    listPath: '/api/v1/hotel/banquets',
    listKey: 'events',
    createPath: '/api/v1/hotel/banquets',
    fields: [
      { name: 'eventName', label: 'Event', placeholder: 'Okafor wedding reception' },
      { name: 'clientName', label: 'Client' },
      { name: 'hotelId', label: 'Hotel', type: 'select', source: 'hotels' },
      { name: 'eventAt', label: 'Event at', type: 'datetime' },
      { name: 'expectedPax', label: 'Expected guests', type: 'number' },
      { name: 'estimatedRevenue', label: 'Estimated revenue', type: 'number' },
    ],
  },
  {
    key: 'campaigns',
    label: 'Sales',
    section: 'guestops',
    listPath: '/api/v1/hotel/sales/campaigns',
    listKey: 'campaigns',
    createPath: '/api/v1/hotel/sales/campaigns',
    fields: [
      { name: 'campaignName', label: 'Campaign', placeholder: 'Q4 corporate drive' },
      { name: 'channel', label: 'Channel', placeholder: 'email' },
      { name: 'budgetAmount', label: 'Budget', type: 'number' },
      { name: 'expectedRevenue', label: 'Expected revenue', type: 'number' },
      { name: 'startsOn', label: 'Starts', type: 'date' },
      { name: 'endsOn', label: 'Ends', type: 'date' },
    ],
  },
  {
    key: 'interactions',
    label: 'CRM',
    section: 'guestops',
    listPath: '/api/v1/hotel/crm/interactions',
    listKey: 'interactions',
    createPath: '/api/v1/hotel/crm/interactions',
    fields: [
      { name: 'customerName', label: 'Customer', placeholder: 'Zenith Energy travel desk' },
      { name: 'interactionType', label: 'Type', placeholder: 'call' },
      { name: 'summary', label: 'Summary' },
      { name: 'satisfactionScore', label: 'Satisfaction (1-5)', type: 'number' },
      { name: 'followUpDue', label: 'Follow up', type: 'date' },
    ],
  },
  {
    key: 'channels',
    label: 'Channels',
    section: 'guestops',
    listPath: '/api/v1/hotel/channels/inventory',
    listKey: 'allocations',
    createPath: '/api/v1/hotel/channels/inventory',
    fields: [
      { name: 'hotelId', label: 'Hotel', type: 'select', source: 'hotels' },
      { name: 'roomTypeId', label: 'Room type', type: 'select', source: 'roomTypes' },
      { name: 'channelName', label: 'Channel', placeholder: 'booking.com' },
      { name: 'allocationDate', label: 'Date', type: 'date' },
      { name: 'allocatedUnits', label: 'Units', type: 'number' },
      { name: 'netRate', label: 'Net rate', type: 'number' },
    ],
  },
  {
    key: 'forecasts',
    label: 'Revenue',
    section: 'guestops',
    listPath: '/api/v1/hotel/revenue/forecasts',
    listKey: 'forecasts',
    createPath: '/api/v1/hotel/revenue/forecasts',
    fields: [
      { name: 'hotelId', label: 'Hotel', type: 'select', source: 'hotels' },
      { name: 'forecastDate', label: 'Date', type: 'date' },
      { name: 'occupancyPercent', label: 'Occupancy %', type: 'number' },
      { name: 'adr', label: 'ADR', type: 'number' },
      { name: 'forecastRevenue', label: 'Forecast revenue', type: 'number' },
      { name: 'strategy', label: 'Strategy' },
    ],
  },
  {
    key: 'spaResources',
    label: 'Spa',
    section: 'guestops',
    listPath: '/api/v1/hotel/spa/resources',
    listKey: 'resources',
    createPath: '/api/v1/hotel/spa/resources',
    fields: [
      { name: 'resourceName', label: 'Resource', placeholder: 'Treatment room 1' },
      { name: 'hotelId', label: 'Hotel', type: 'select', source: 'hotels' },
      { name: 'resourceType', label: 'Type', placeholder: 'treatment_room' },
      { name: 'capacity', label: 'Capacity', type: 'number', placeholder: '1' },
    ],
  },
  {
    key: 'spaBookings',
    label: 'Spa bookings',
    section: 'guestops',
    listPath: '/api/v1/hotel/spa/bookings',
    listKey: 'bookings',
    createPath: '/api/v1/hotel/spa/bookings',
    fields: [
      { name: 'resourceId', label: 'Spa resource id' },
      { name: 'serviceName', label: 'Service', placeholder: 'Deep tissue massage' },
      { name: 'hotelId', label: 'Hotel', type: 'select', source: 'hotels' },
      { name: 'startsAt', label: 'Starts', type: 'datetime' },
      { name: 'durationMinutes', label: 'Minutes', type: 'number', placeholder: '60' },
      { name: 'price', label: 'Price', type: 'number' },
    ],
  },
  {
    key: 'tours',
    label: 'Tours',
    section: 'guestops',
    listPath: '/api/v1/hotel/tours/packages',
    listKey: 'packages',
    createPath: '/api/v1/hotel/tours/packages',
    fields: [
      { name: 'tourName', label: 'Tour', placeholder: 'Lekki conservation walk' },
      { name: 'destination', label: 'Destination' },
      { name: 'capacity', label: 'Capacity', type: 'number' },
      { name: 'pricePerPerson', label: 'Price per person', type: 'number' },
    ],
  },
  {
    key: 'callcentre',
    label: 'Call centre',
    section: 'guestops',
    listPath: '/api/v1/hotel/callcentre/reservations',
    listKey: 'reservations',
    createPath: '/api/v1/hotel/callcentre/reservations',
    fields: [
      { name: 'hotelId', label: 'Hotel', type: 'select', source: 'hotels' },
      { name: 'arrivalDate', label: 'Arrival', type: 'date' },
      { name: 'departureDate', label: 'Departure', type: 'date' },
      { name: 'channel', label: 'Channel', placeholder: 'call_centre' },
      { name: 'amount', label: 'Amount', type: 'number' },
    ],
  },
  {
    key: 'foodSafety',
    label: 'Food safety',
    section: 'guestops',
    listPath: '/api/v1/hotel/foodsafety/checks',
    listKey: 'checks',
    createPath: '/api/v1/hotel/foodsafety/checks',
    fields: [
      { name: 'areaName', label: 'Area', placeholder: 'Cold room 1' },
      { name: 'checkType', label: 'Check type', placeholder: 'temperature' },
      { name: 'scheduledAt', label: 'Scheduled', type: 'datetime' },
      { name: 'correctiveAction', label: 'Corrective action' },
    ],
  },
  {
    key: 'corporate',
    label: 'Corporate billing',
    section: 'guestops',
    listPath: '/api/v1/hotel/corporate/accounts',
    listKey: 'accounts',
    createPath: '/api/v1/hotel/corporate/accounts',
    fields: [
      { name: 'accountName', label: 'Account', placeholder: 'Zenith Energy Ltd' },
      { name: 'billingEmail', label: 'Billing email' },
      { name: 'creditLimit', label: 'Credit limit', type: 'number' },
      {
        name: 'priority',
        label: 'Priority',
        type: 'select',
        options: [
          { value: 'standard', label: 'Standard' },
          { value: 'premium', label: 'Premium' },
        ],
      },
    ],
  },
  {
    key: 'franchise',
    label: 'Brand standards',
    section: 'guestops',
    listPath: '/api/v1/hotel/franchise/standards',
    listKey: 'standards',
    createPath: '/api/v1/hotel/franchise/standards',
    fields: [
      { name: 'standardName', label: 'Standard', placeholder: 'Brand arrival experience' },
      { name: 'category', label: 'Category', placeholder: 'guest_journey' },
      { name: 'description', label: 'Description' },
      { name: 'mandatory', label: 'Mandatory', type: 'select', options: yesNo },
    ],
  },
  {
    key: 'restaurantReservations',
    label: 'Reservations',
    section: 'outlets',
    listPath: '/api/v1/restaurant/reservations',
    listKey: 'reservations',
    createPath: '/api/v1/restaurant/reservations',
    fields: [
      { name: 'outletId', label: 'Outlet', type: 'select', source: 'outlets' },
      { name: 'customerName', label: 'Guest name' },
      { name: 'customerPhone', label: 'Phone' },
      { name: 'partySize', label: 'Party size', type: 'number' },
      { name: 'reservationAt', label: 'Reserved for', type: 'datetime' },
      { name: 'durationMinutes', label: 'Minutes', type: 'number', placeholder: '120' },
    ],
  },
  {
    key: 'waitlist',
    label: 'Waitlist',
    section: 'outlets',
    listPath: '/api/v1/restaurant/waitlist',
    listKey: 'waitlist',
    createPath: '/api/v1/restaurant/waitlist',
    fields: [
      { name: 'outletId', label: 'Outlet', type: 'select', source: 'outlets' },
      { name: 'customerName', label: 'Guest name' },
      { name: 'customerPhone', label: 'Phone' },
      { name: 'partySize', label: 'Party size', type: 'number' },
      { name: 'quotedMinutes', label: 'Quoted minutes', type: 'number', placeholder: '15' },
    ],
  },
  {
    key: 'customers',
    label: 'Customers',
    section: 'outlets',
    listPath: '/api/v1/restaurant/customers',
    listKey: 'customers',
    createPath: '/api/v1/restaurant/customers',
    fields: [
      { name: 'fullName', label: 'Name' },
      { name: 'phone', label: 'Phone' },
      { name: 'email', label: 'Email' },
      {
        name: 'segment',
        label: 'Segment',
        type: 'select',
        options: ['general', 'frequent', 'vip', 'corporate', 'resident'].map((value) => ({ value, label: value })),
      },
    ],
  },
  {
    key: 'promotions',
    label: 'Promotions',
    section: 'outlets',
    listPath: '/api/v1/restaurant/promotions',
    listKey: 'promotions',
    createPath: '/api/v1/restaurant/promotions',
    fields: [
      { name: 'promoCode', label: 'Promo code', placeholder: 'EID15' },
      { name: 'promoName', label: 'Name', placeholder: 'Eid celebration' },
      { name: 'discountPercent', label: 'Discount %', type: 'number' },
      { name: 'minimumSubtotal', label: 'Minimum spend', type: 'number' },
      { name: 'startsAt', label: 'Starts', type: 'datetime' },
      { name: 'endsAt', label: 'Ends', type: 'datetime' },
    ],
  },
  {
    key: 'barEvents',
    label: 'Bar events',
    section: 'outlets',
    listPath: '/api/v1/bar/events',
    listKey: 'events',
    createPath: '/api/v1/bar/events',
    fields: [
      { name: 'barId', label: 'Bar', type: 'select', source: 'bars' },
      { name: 'eventName', label: 'Event', placeholder: 'Afrobeat night' },
      { name: 'eventDate', label: 'Date', type: 'date' },
      { name: 'startsAt', label: 'Start time', placeholder: '20:00' },
      { name: 'capacity', label: 'Capacity', type: 'number' },
      { name: 'ticketPrice', label: 'Ticket price', type: 'number' },
    ],
  },
];

const HIDDEN_COLUMNS = new Set([
  'id',
  'tenant_id',
  'branch_id',
  'hotel_id',
  'outlet_id',
  'bar_id',
  'created_at',
  'updated_at',
  'board_id',
  'journal_entry_id',
  'posting_journal_id',
  'payment_journal_id',
]);

function humanise(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderValue(value: unknown, key = ''): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(value) : new Date(value).toLocaleString();
  }
  const identifier = /(^|_)(code|number|reference|id)$/.test(key);
  if (!identifier && (typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(String(value)))) {
    return Number(value).toLocaleString();
  }
  return String(value);
}

export function OperationsPage() {
  const [section, setSection] = useState<SectionKey>('backoffice');
  const sectionResources = useMemo(
    () => RESOURCES.filter((resource) => resource.section === section),
    [section],
  );
  const [resourceKey, setResourceKey] = useState(sectionResources[0]!.key);
  useEffect(() => {
    if (!sectionResources.some((resource) => resource.key === resourceKey)) {
      setResourceKey(sectionResources[0]!.key);
    }
  }, [sectionResources, resourceKey]);

  const resource = RESOURCES.find((item) => item.key === resourceKey) ?? RESOURCES[0]!;
  const [values, setValues] = useState<Record<string, string>>({});
  const action = useAction();
  useEffect(() => {
    setValues({});
    action.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.key]);

  const hotels = useAsync(() => api<{ hotels: Row[] }>('GET', '/api/v1/hotel/hotels'), []);
  const outlets = useAsync(() => api<{ outlets: Row[] }>('GET', '/api/v1/restaurant/outlets'), []);
  const bars = useAsync(() => api<{ outlets: Row[] }>('GET', '/api/v1/bar/outlets'), []);
  const accounts = useAsync(() => api<{ accounts: Row[] }>('GET', '/api/v1/finance/accounts'), []);
  const roomTypes = useAsync(
    () =>
      hotels.data?.hotels?.[0]?.id
        ? api<{ roomTypes: Row[] }>('GET', `/api/v1/hotel/room-types?hotelId=${hotels.data.hotels[0].id}`)
        : Promise.resolve({ roomTypes: [] as Row[] }),
    [hotels.data?.hotels?.[0]?.id],
  );

  const listing = useAsync(
    () => api<Record<string, Row[]>>('GET', resource.listPath),
    [resource.listPath],
  );

  const rows = (listing.data?.[resource.listKey] ?? []) as Row[];
  const columns = useMemo(() => {
    const keys = Object.keys(rows[0] ?? {}).filter((key) => !HIDDEN_COLUMNS.has(key));
    return keys.slice(0, 7).map((key) => ({ key, header: humanise(key) }));
  }, [rows]);

  function optionsFor(field: FieldSpec): Array<{ value: string; label: string }> {
    if (field.options) return field.options;
    if (field.source === 'hotels') {
      return (hotels.data?.hotels ?? []).map((hotel) => ({
        value: hotel.id,
        label: `${hotel.hotel_code} · ${hotel.hotel_name}`,
      }));
    }
    if (field.source === 'outlets') {
      return (outlets.data?.outlets ?? []).map((outlet) => ({
        value: outlet.id,
        label: `${outlet.outlet_code} · ${outlet.outlet_name}`,
      }));
    }
    if (field.source === 'bars') {
      return (bars.data?.outlets ?? []).map((outlet) => ({
        value: outlet.id,
        label: `${outlet.bar_code} · ${outlet.bar_name}`,
      }));
    }
    if (field.source === 'roomTypes') {
      return (roomTypes.data?.roomTypes ?? []).map((roomType) => ({
        value: roomType.id,
        label: `${roomType.room_type_code} · ${roomType.room_type_name}`,
      }));
    }
    const ledger = accounts.data?.accounts ?? [];
    return ledger
      .filter((account) => String(account.account_code).startsWith('5') || String(account.account_code).startsWith('6'))
      .map((account) => ({ value: account.id, label: `${account.account_code} · ${account.account_name}` }));
  }

  async function submit() {
    const body: Record<string, unknown> = {};
    for (const field of resource.fields) {
      const raw = values[field.name];
      if (raw === undefined || raw === '') continue;
      body[field.name] =
        field.type === 'number'
          ? Number(raw)
          : field.type === 'datetime'
            ? new Date(raw).toISOString()
            : field.type === 'select' && (raw === 'true' || raw === 'false')
              ? raw === 'true'
              : raw;
    }
    const extra = resource.compose?.(values) ?? {};
    const ok = await action.run(
      () => api('POST', resource.createPath, { ...body, ...extra }),
      `${resource.label} record created`,
    );
    if (ok) {
      setValues({});
      listing.reload();
    }
  }

  return (
    <div className="stack">
      <Card
        title="Business tools"
        subtitle="Budget control, treasury, compliance and the guest/commercial modules, all on the same tenant ledger."
      >
        <Tabs tabs={SECTIONS} active={section} onChange={(key) => setSection(key)} />
        <Tabs
          tabs={sectionResources.map((item) => ({ key: item.key, label: item.label }))}
          active={resource.key}
          onChange={(key) => setResourceKey(key)}
        />
        <p className="subtle">{MODULE_HINTS[resource.key] ?? resource.label}</p>
      </Card>

      <Card title={`${resource.label} register`} subtitle={`${rows.length} record(s)`}>
        <Table
          columns={columns.map((column) => ({
            ...column,
            render: (row: Row) => renderValue(row[column.key], column.key),
          }))}
          rows={rows}
          loading={listing.loading}
          empty="No records yet. Create the first one below."
        />
      </Card>

      <Card title={`New ${resource.label.replace(/s$/, '').toLowerCase()}`}>
        <Notice error={action.error ?? listing.error} notice={action.notice} />
        <FormRow>
          {resource.fields.map((field) => (
            <Field key={field.name} label={field.label} hint={field.hint}>
              {field.type === 'select' ? (
                <Select
                  value={values[field.name] ?? ''}
                  onChange={(value) => setValues((prev) => ({ ...prev, [field.name]: value }))}
                  options={optionsFor(field)}
                  placeholder="Select…"
                />
              ) : (
                <Input
                  value={values[field.name] ?? ''}
                  onChange={(value) => setValues((prev) => ({ ...prev, [field.name]: value }))}
                  type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime-local' : 'text'}
                  placeholder={field.placeholder}
                />
              )}
            </Field>
          ))}
        </FormRow>
        <Button onClick={submit} disabled={action.busy}>
          {action.busy ? 'Saving…' : `Create ${resource.label.replace(/s$/, '').toLowerCase()}`}
        </Button>
      </Card>

      <Card title="Ledger position" subtitle="Posted balances by account class for the current tenant.">
        <Table
          columns={[
            { key: 'account_code', header: 'Code' },
            { key: 'account_name', header: 'Account' },
            { key: 'account_class', header: 'Class' },
            { key: 'normal_balance', header: 'Normal' },
          ]}
          rows={(accounts.data?.accounts ?? []).slice(0, 12)}
          loading={accounts.loading}
        />
      </Card>

    </div>
  );
}
