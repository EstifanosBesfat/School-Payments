export interface PayView {
  school: { name: string; code: string; logoUrl: string | null; status: string; city: string | null };
  student: { name: string; code: string; grade: string; section: string | null };
  invoice: {
    number: string;
    term: string | null;
    status: string;
    currency: string;
    totalAmount: number;
    paidAmount: number;
    balance: number;
    dueDate: string;
    lines: { description: string; amount: number }[];
  };
  payments: { txRef: string; status: string; amount: number; method: string | null; createdAt: string; succeededAt: string | null }[];
  receipts: { id: string; receiptNo: string; verificationCode: string; issuedAt: string; pdfReady: boolean }[];
  acceptingPayments: boolean;
}

export interface PayStatus {
  rechecking?: boolean;
  invoiceStatus: string;
  payment: { txRef: string; status: string; amount: number; method: string | null; payer: string };
  receipt: { id: string; receiptNo: string; verificationCode: string; pdfReady: boolean } | null;
}
