export interface InvoiceListItemDto {
  id: string;
  label: string;
  date: string;
  amount: string;
  pdfUrl: string | null;
}
