/**
 * A synthetic YNAB "Export budget" mirroring the real export's shapes (see the
 * private notes): a split whose lines carry different payees and a transfer,
 * transfer pairs with and without a category, a hidden category, the
 * Credit Card Payments group, an uncategorised row, an overspend that YNAB
 * reset at month end. Numbers are chosen so the Plan is consistent with the
 * register under YNAB's rules; tests assert the builder reproduces them.
 *
 * Accounts: Chequing, Card, Partner (person), Brokerage (off-budget).
 */
export const REGISTER_CSV = `"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"
"Chequing","","07/01/2026","Starting Balance","Inflow: Ready to Assign","Inflow","Ready to Assign","","$0.00","$1000.00","Reconciled"
"Card","","07/05/2026","Grocer","Everyday: Groceries","Everyday","Groceries","","$45.00","$0.00","Cleared"
"Chequing","","07/10/2026","Shop","Everyday: Groceries","Everyday","Groceries","Split (1/3) tape","$10.00","$0.00","Cleared"
"Chequing","","07/10/2026","Other Shop","Everyday: Fun","Everyday","Fun","Split (2/3) ","$5.00","$0.00","Cleared"
"Chequing","","07/10/2026","Transfer : Partner","","","","Split (3/3) ","$20.00","$0.00","Cleared"
"Partner","","07/10/2026","Transfer : Chequing","","","","","$0.00","$20.00","Uncleared"
"Chequing","","07/15/2026","Transfer : Card","","","","","$100.00","$0.00","Cleared"
"Card","","07/15/2026","Transfer : Chequing","","","","","$0.00","$100.00","Cleared"
"Chequing","","07/20/2026","Transfer : Brokerage","Bills: Rent","Bills","Rent","","$200.00","$0.00","Cleared"
"Brokerage","","07/20/2026","Transfer : Chequing","","","","","$0.00","$200.00","Cleared"
"Chequing","","07/22/2026","Hobby Store","Hidden Categories: Old Hobby","Hidden Categories","Old Hobby","","$3.00","$0.00","Cleared"
"Card","","08/03/2026","Arcade","Everyday: Fun","Everyday","Fun","","$60.00","$0.00","Cleared"
"Partner","","08/10/2026","Grocer","Everyday: Groceries","Everyday","Groceries","their trip","$8.00","$0.00","Cleared"
"Card","","08/20/2026","Mystery","","","","","$7.00","$0.00","Cleared"
"Brokerage","","08/25/2026","The Ether","","","","","$0.00","$9.00","Cleared"
"Chequing","","09/01/2026","Employer","Inflow: Ready to Assign","Inflow","Ready to Assign","","$0.00","$500.00","Cleared"
"Card","","09/03/2026","Grocer","Everyday: Groceries","Everyday","Groceries","","$12.34","$0.00","Cleared"
`;

export const PLAN_CSV = `"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"
"Jul 2026","Everyday: Groceries","Everyday","Groceries","$100.00","-$55.00","$45.00"
"Jul 2026","Everyday: Fun","Everyday","Fun","$50.00","-$5.00","$45.00"
"Jul 2026","Bills: Rent","Bills","Rent","$200.00","-$200.00","$0.00"
"Jul 2026","Hidden Categories: Old Hobby","Hidden Categories","Old Hobby","$0.00","-$3.00","-$3.00"
"Jul 2026","Credit Card Payments: Card","Credit Card Payments","Card","$0.00","-$55.00","-$55.00"
"Aug 2026","Everyday: Groceries","Everyday","Groceries","$100.00","-$8.00","$137.00"
"Aug 2026","Everyday: Fun","Everyday","Fun","$0.00","-$60.00","-$15.00"
"Aug 2026","Bills: Rent","Bills","Rent","$0.00","$0.00","$0.00"
"Aug 2026","Hidden Categories: Old Hobby","Hidden Categories","Old Hobby","$0.00","$0.00","$0.00"
"Aug 2026","Credit Card Payments: Card","Credit Card Payments","Card","$0.00","$60.00","$5.00"
"Sep 2026","Everyday: Groceries","Everyday","Groceries","$100.00","-$12.34","$224.66"
"Sep 2026","Everyday: Fun","Everyday","Fun","$0.00","$0.00","$0.00"
"Sep 2026","Bills: Rent","Bills","Rent","$0.00","$0.00","$0.00"
"Sep 2026","Hidden Categories: Old Hobby","Hidden Categories","Old Hobby","$0.00","$0.00","$0.00"
"Sep 2026","Credit Card Payments: Card","Credit Card Payments","Card","$0.00","$12.34","$17.34"
`;
