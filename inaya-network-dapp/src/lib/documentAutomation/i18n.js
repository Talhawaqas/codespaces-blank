// src/lib/documentAutomation/i18n.js
//
// Document Automation SOW §21/§22 -- localization. Label dictionaries for
// localized templates, locale-aware number/date/currency/percent
// formatting (Intl, never a hard-coded currency presentation), and RTL
// detection. Latin digits are used in every locale (the "-u-nu-latn"
// extension) because that is the convention on commercial documents in the
// AED/PKR markets Inaya serves, and it keeps figures unambiguous when a
// document is audited across locales.

import { CURRENCY_EXPONENTS } from "./money.js";

export const SUPPORTED_LOCALES = ["en-US", "en-GB", "ar-AE", "ur-PK", "fr-FR", "de-DE", "es-ES"];
export const RTL_LANGUAGES = ["ar", "ur", "he", "fa"];

export function languageOf(locale) {
  return String(locale || "en-US").split("-")[0].toLowerCase();
}
export function isRtlLocale(locale) {
  return RTL_LANGUAGES.includes(languageOf(locale));
}
export function normalizeLocale(locale) {
  if (!locale) return "en-US";
  const found = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === String(locale).toLowerCase());
  if (found) return found;
  const lang = languageOf(locale);
  return SUPPORTED_LOCALES.find((l) => languageOf(l) === lang) || null;
}

const EN = {
  invoice: "INVOICE", purchaseOrder: "PURCHASE ORDER", quotation: "QUOTATION", receipt: "RECEIPT",
  statement: "STATEMENT OF ACCOUNT", creditNote: "CREDIT NOTE", debitNote: "DEBIT NOTE",
  deliveryNote: "DELIVERY NOTE", businessReport: "BUSINESS REPORT",
  number: "Number", date: "Date", issueDate: "Issue date", dueDate: "Due date", validUntil: "Valid until",
  status: "Status", billTo: "Bill to", shipTo: "Ship to", from: "From", vendor: "Vendor", customer: "Customer",
  description: "Description", sku: "SKU", quantity: "Qty", unitPrice: "Unit price", discount: "Discount",
  tax: "Tax", lineTotal: "Total", subtotal: "Subtotal", shipping: "Shipping", fees: "Fees", total: "Total",
  amountPaid: "Amount paid", amountDue: "Amount due", paymentTerms: "Payment terms", notes: "Notes",
  terms: "Terms", reference: "Reference", poNumber: "PO number", taxId: "Tax ID", page: "Page", of: "of",
  approvedBy: "Approved by", approvedAt: "Approved on", approvalStatus: "Approval", approved: "APPROVED",
  pendingApproval: "PENDING APPROVAL", authorizedSignatory: "Authorized signatory", documentId: "Document ID",
  documentHash: "Fingerprint (SHA-256)", verifyAt: "Verify this document", generatedOn: "Generated",
  version: "Version", preview: "PREVIEW - NOT AN OFFICIAL DOCUMENT", draft: "DRAFT", currency: "Currency",
  balance: "Balance", openingBalance: "Opening balance", closingBalance: "Closing balance",
  charges: "Charges", payments: "Payments", invoiceRef: "Invoice", paymentMethod: "Payment method",
  paymentDate: "Payment date", receivedWithThanks: "Payment received with thanks", deliveredBy: "Delivered by",
  receivedBy: "Received by", period: "Period", summary: "Summary", highlights: "Highlights", alerts: "Alerts",
  indicator: "Indicator", value: "Value", change: "Change", original: "Original invoice", reason: "Reason",
  adjustment: "Adjustment", supplier: "Supplier", orderedItems: "Ordered items", delivered: "Delivered",
  ordered: "Ordered", pending: "Pending", none: "None", yes: "Yes", no: "No", taxableAmount: "Taxable amount",
  discountTotal: "Total discount", invoiceDiscount: "Invoice discount", customerTaxId: "Customer tax ID", shipTo2: "Shipping address",
  signature: "Signature", date2: "Date", preparedBy: "Prepared by", ageing: "Ageing", current: "Current",
};

const AR = {
  invoice: "فاتورة", purchaseOrder: "أمر شراء", quotation: "عرض سعر", receipt: "إيصال",
  statement: "كشف حساب", creditNote: "إشعار دائن", debitNote: "إشعار مدين", deliveryNote: "إشعار تسليم",
  businessReport: "تقرير أعمال",
  number: "الرقم", date: "التاريخ", issueDate: "تاريخ الإصدار", dueDate: "تاريخ الاستحقاق", validUntil: "صالح حتى",
  status: "الحالة", billTo: "فاتورة إلى", shipTo: "شحن إلى", from: "من", vendor: "المورد", customer: "العميل",
  description: "الوصف", sku: "رمز الصنف", quantity: "الكمية", unitPrice: "سعر الوحدة", discount: "الخصم",
  tax: "الضريبة", lineTotal: "الإجمالي", subtotal: "المجموع الفرعي", shipping: "الشحن", fees: "الرسوم",
  total: "الإجمالي", amountPaid: "المبلغ المدفوع", amountDue: "المبلغ المستحق", paymentTerms: "شروط الدفع",
  notes: "ملاحظات", terms: "الشروط", reference: "المرجع", poNumber: "رقم أمر الشراء", taxId: "الرقم الضريبي",
  page: "صفحة", of: "من", approvedBy: "اعتمده", approvedAt: "تاريخ الاعتماد", approvalStatus: "الاعتماد",
  approved: "معتمد", pendingApproval: "بانتظار الاعتماد", authorizedSignatory: "المفوض بالتوقيع",
  documentId: "معرّف المستند", documentHash: "البصمة (SHA-256)", verifyAt: "تحقق من هذا المستند",
  generatedOn: "تاريخ الإنشاء", version: "الإصدار", preview: "معاينة - ليس مستندًا رسميًا", draft: "مسودة",
  currency: "العملة", balance: "الرصيد", openingBalance: "الرصيد الافتتاحي", closingBalance: "الرصيد الختامي",
  charges: "المطالبات", payments: "المدفوعات", invoiceRef: "الفاتورة", paymentMethod: "طريقة الدفع",
  paymentDate: "تاريخ الدفع", receivedWithThanks: "تم استلام الدفعة مع الشكر", deliveredBy: "سلّمه",
  receivedBy: "استلمه", period: "الفترة", summary: "الملخص", highlights: "أبرز النقاط", alerts: "التنبيهات",
  indicator: "المؤشر", value: "القيمة", change: "التغيير", original: "الفاتورة الأصلية", reason: "السبب",
  adjustment: "التعديل", supplier: "المورد", orderedItems: "الأصناف المطلوبة", delivered: "المسلّم",
  ordered: "المطلوب", pending: "المتبقي", none: "لا يوجد", yes: "نعم", no: "لا", taxableAmount: "المبلغ الخاضع للضريبة",
  discountTotal: "إجمالي الخصم", invoiceDiscount: "خصم الفاتورة", customerTaxId: "الرقم الضريبي للعميل", shipTo2: "عنوان الشحن",
  signature: "التوقيع", date2: "التاريخ", preparedBy: "أعدّه", ageing: "أعمار الديون", current: "الحالي",
};

const UR = {
  invoice: "انوائس", purchaseOrder: "خریداری آرڈر", quotation: "کوٹیشن", receipt: "رسید",
  statement: "اکاؤنٹ اسٹیٹمنٹ", creditNote: "کریڈٹ نوٹ", debitNote: "ڈیبٹ نوٹ", deliveryNote: "ڈیلیوری نوٹ",
  businessReport: "کاروباری رپورٹ",
  number: "نمبر", date: "تاریخ", issueDate: "اجرا کی تاریخ", dueDate: "آخری تاریخ ادائیگی", validUntil: "میعاد تک",
  status: "حیثیت", billTo: "بل برائے", shipTo: "ترسیل برائے", from: "از", vendor: "فروخت کنندہ", customer: "گاہک",
  description: "تفصیل", sku: "آئٹم کوڈ", quantity: "مقدار", unitPrice: "فی یونٹ قیمت", discount: "رعایت",
  tax: "ٹیکس", lineTotal: "کل", subtotal: "ذیلی کل", shipping: "ترسیل", fees: "فیس", total: "کل",
  amountPaid: "ادا شدہ رقم", amountDue: "واجب الادا رقم", paymentTerms: "ادائیگی کی شرائط", notes: "نوٹس",
  terms: "شرائط", reference: "حوالہ", poNumber: "پی او نمبر", taxId: "ٹیکس نمبر", page: "صفحہ", of: "از",
  approvedBy: "منظور کنندہ", approvedAt: "منظوری کی تاریخ", approvalStatus: "منظوری", approved: "منظور شدہ",
  pendingApproval: "منظوری زیر التوا", authorizedSignatory: "مجاز دستخط کنندہ", documentId: "دستاویز آئی ڈی",
  documentHash: "فنگر پرنٹ (SHA-256)", verifyAt: "اس دستاویز کی تصدیق کریں", generatedOn: "تیار کردہ",
  version: "ورژن", preview: "پیش نظارہ - سرکاری دستاویز نہیں", draft: "مسودہ", currency: "کرنسی",
  balance: "بیلنس", openingBalance: "ابتدائی بیلنس", closingBalance: "اختتامی بیلنس", charges: "واجبات",
  payments: "ادائیگیاں", invoiceRef: "انوائس", paymentMethod: "ادائیگی کا طریقہ", paymentDate: "ادائیگی کی تاریخ",
  receivedWithThanks: "ادائیگی شکریہ کے ساتھ موصول ہوئی", deliveredBy: "ترسیل کنندہ", receivedBy: "وصول کنندہ",
  period: "مدت", summary: "خلاصہ", highlights: "اہم نکات", alerts: "انتباہات", indicator: "اشارہ", value: "قدر",
  change: "تبدیلی", original: "اصل انوائس", reason: "وجہ", adjustment: "ایڈجسٹمنٹ", supplier: "سپلائر",
  orderedItems: "آرڈر کردہ اشیاء", delivered: "ترسیل شدہ", ordered: "آرڈر شدہ", pending: "باقی",
  none: "کوئی نہیں", yes: "ہاں", no: "نہیں", taxableAmount: "قابل ٹیکس رقم", discountTotal: "کل رعایت", invoiceDiscount: "انوائس رعایت",
  customerTaxId: "گاہک کا ٹیکس نمبر", shipTo2: "ترسیل کا پتہ", signature: "دستخط", date2: "تاریخ",
  preparedBy: "تیار کنندہ", ageing: "بقایا جات کی عمر", current: "موجودہ",
};

const FR = {
  invoice: "FACTURE", purchaseOrder: "BON DE COMMANDE", quotation: "DEVIS", receipt: "REÇU",
  statement: "RELEVÉ DE COMPTE", creditNote: "AVOIR", debitNote: "NOTE DE DÉBIT", deliveryNote: "BON DE LIVRAISON",
  businessReport: "RAPPORT D'ACTIVITÉ",
  number: "Numéro", date: "Date", issueDate: "Date d'émission", dueDate: "Date d'échéance", validUntil: "Valable jusqu'au",
  status: "Statut", billTo: "Facturer à", shipTo: "Livrer à", from: "De", vendor: "Fournisseur", customer: "Client",
  description: "Description", sku: "Réf.", quantity: "Qté", unitPrice: "Prix unitaire", discount: "Remise",
  tax: "Taxe", lineTotal: "Total", subtotal: "Sous-total", shipping: "Livraison", fees: "Frais", total: "Total",
  amountPaid: "Montant payé", amountDue: "Solde dû", paymentTerms: "Conditions de paiement", notes: "Notes",
  terms: "Conditions", reference: "Référence", poNumber: "N° de commande", taxId: "N° de TVA", page: "Page", of: "sur",
  approvedBy: "Approuvé par", approvedAt: "Approuvé le", approvalStatus: "Approbation", approved: "APPROUVÉ",
  pendingApproval: "EN ATTENTE D'APPROBATION", authorizedSignatory: "Signataire autorisé", documentId: "ID du document",
  documentHash: "Empreinte (SHA-256)", verifyAt: "Vérifier ce document", generatedOn: "Généré le",
  version: "Version", preview: "APERÇU - DOCUMENT NON OFFICIEL", draft: "BROUILLON", currency: "Devise",
  balance: "Solde", openingBalance: "Solde d'ouverture", closingBalance: "Solde de clôture", charges: "Factures",
  payments: "Paiements", invoiceRef: "Facture", paymentMethod: "Mode de paiement", paymentDate: "Date de paiement",
  receivedWithThanks: "Paiement reçu avec nos remerciements", deliveredBy: "Livré par", receivedBy: "Reçu par",
  period: "Période", summary: "Résumé", highlights: "Points clés", alerts: "Alertes", indicator: "Indicateur",
  value: "Valeur", change: "Variation", original: "Facture d'origine", reason: "Motif", adjustment: "Ajustement",
  supplier: "Fournisseur", orderedItems: "Articles commandés", delivered: "Livré", ordered: "Commandé",
  pending: "Restant", none: "Aucun", yes: "Oui", no: "Non", taxableAmount: "Montant imposable",
  discountTotal: "Remise totale", invoiceDiscount: "Remise globale", customerTaxId: "N° de TVA du client", shipTo2: "Adresse de livraison",
  signature: "Signature", date2: "Date", preparedBy: "Préparé par", ageing: "Antériorité", current: "Courant",
};

const DE = {
  invoice: "RECHNUNG", purchaseOrder: "BESTELLUNG", quotation: "ANGEBOT", receipt: "QUITTUNG",
  statement: "KONTOAUSZUG", creditNote: "GUTSCHRIFT", debitNote: "BELASTUNGSANZEIGE", deliveryNote: "LIEFERSCHEIN",
  businessReport: "GESCHÄFTSBERICHT",
  number: "Nummer", date: "Datum", issueDate: "Ausstellungsdatum", dueDate: "Fälligkeitsdatum", validUntil: "Gültig bis",
  status: "Status", billTo: "Rechnung an", shipTo: "Lieferung an", from: "Von", vendor: "Lieferant", customer: "Kunde",
  description: "Beschreibung", sku: "Art.-Nr.", quantity: "Menge", unitPrice: "Einzelpreis", discount: "Rabatt",
  tax: "Steuer", lineTotal: "Summe", subtotal: "Zwischensumme", shipping: "Versand", fees: "Gebühren", total: "Gesamt",
  amountPaid: "Bezahlt", amountDue: "Offener Betrag", paymentTerms: "Zahlungsbedingungen", notes: "Hinweise",
  terms: "Bedingungen", reference: "Referenz", poNumber: "Bestellnummer", taxId: "USt-IdNr.", page: "Seite", of: "von",
  approvedBy: "Genehmigt von", approvedAt: "Genehmigt am", approvalStatus: "Genehmigung", approved: "GENEHMIGT",
  pendingApproval: "GENEHMIGUNG AUSSTEHEND", authorizedSignatory: "Zeichnungsberechtigter", documentId: "Dokument-ID",
  documentHash: "Fingerabdruck (SHA-256)", verifyAt: "Dokument prüfen", generatedOn: "Erstellt",
  version: "Version", preview: "VORSCHAU - KEIN OFFIZIELLES DOKUMENT", draft: "ENTWURF", currency: "Währung",
  balance: "Saldo", openingBalance: "Anfangssaldo", closingBalance: "Endsaldo", charges: "Rechnungen",
  payments: "Zahlungen", invoiceRef: "Rechnung", paymentMethod: "Zahlungsart", paymentDate: "Zahlungsdatum",
  receivedWithThanks: "Zahlung dankend erhalten", deliveredBy: "Geliefert von", receivedBy: "Empfangen von",
  period: "Zeitraum", summary: "Zusammenfassung", highlights: "Highlights", alerts: "Hinweise", indicator: "Kennzahl",
  value: "Wert", change: "Änderung", original: "Ursprüngliche Rechnung", reason: "Grund", adjustment: "Korrektur",
  supplier: "Lieferant", orderedItems: "Bestellte Artikel", delivered: "Geliefert", ordered: "Bestellt",
  pending: "Offen", none: "Keine", yes: "Ja", no: "Nein", taxableAmount: "Steuerpflichtiger Betrag",
  discountTotal: "Gesamtrabatt", invoiceDiscount: "Gesamtrabatt auf Rechnung", customerTaxId: "USt-IdNr. des Kunden", shipTo2: "Lieferadresse",
  signature: "Unterschrift", date2: "Datum", preparedBy: "Erstellt von", ageing: "Fälligkeiten", current: "Aktuell",
};

const ES = {
  invoice: "FACTURA", purchaseOrder: "ORDEN DE COMPRA", quotation: "PRESUPUESTO", receipt: "RECIBO",
  statement: "ESTADO DE CUENTA", creditNote: "NOTA DE CRÉDITO", debitNote: "NOTA DE DÉBITO", deliveryNote: "ALBARÁN DE ENTREGA",
  businessReport: "INFORME DE NEGOCIO",
  number: "Número", date: "Fecha", issueDate: "Fecha de emisión", dueDate: "Fecha de vencimiento", validUntil: "Válido hasta",
  status: "Estado", billTo: "Facturar a", shipTo: "Enviar a", from: "De", vendor: "Proveedor", customer: "Cliente",
  description: "Descripción", sku: "Ref.", quantity: "Cant.", unitPrice: "Precio unitario", discount: "Descuento",
  tax: "Impuesto", lineTotal: "Total", subtotal: "Subtotal", shipping: "Envío", fees: "Cargos", total: "Total",
  amountPaid: "Importe pagado", amountDue: "Importe pendiente", paymentTerms: "Condiciones de pago", notes: "Notas",
  terms: "Condiciones", reference: "Referencia", poNumber: "N.º de pedido", taxId: "NIF", page: "Página", of: "de",
  approvedBy: "Aprobado por", approvedAt: "Aprobado el", approvalStatus: "Aprobación", approved: "APROBADO",
  pendingApproval: "PENDIENTE DE APROBACIÓN", authorizedSignatory: "Firmante autorizado", documentId: "ID del documento",
  documentHash: "Huella (SHA-256)", verifyAt: "Verificar este documento", generatedOn: "Generado",
  version: "Versión", preview: "VISTA PREVIA - NO ES UN DOCUMENTO OFICIAL", draft: "BORRADOR", currency: "Moneda",
  balance: "Saldo", openingBalance: "Saldo inicial", closingBalance: "Saldo final", charges: "Facturas",
  payments: "Pagos", invoiceRef: "Factura", paymentMethod: "Método de pago", paymentDate: "Fecha de pago",
  receivedWithThanks: "Pago recibido, gracias", deliveredBy: "Entregado por", receivedBy: "Recibido por",
  period: "Periodo", summary: "Resumen", highlights: "Aspectos destacados", alerts: "Alertas", indicator: "Indicador",
  value: "Valor", change: "Variación", original: "Factura original", reason: "Motivo", adjustment: "Ajuste",
  supplier: "Proveedor", orderedItems: "Artículos pedidos", delivered: "Entregado", ordered: "Pedido",
  pending: "Pendiente", none: "Ninguno", yes: "Sí", no: "No", taxableAmount: "Base imponible",
  discountTotal: "Descuento total", invoiceDiscount: "Descuento global", customerTaxId: "NIF del cliente", shipTo2: "Dirección de envío",
  signature: "Firma", date2: "Fecha", preparedBy: "Preparado por", ageing: "Antigüedad", current: "Corriente",
};

const DICTIONARIES = { en: EN, ar: AR, ur: UR, fr: FR, de: DE, es: ES };
export const LABEL_KEYS = Object.keys(EN);

/** Resolves a label key for a locale; falls back to English rather than
 *  ever rendering an empty label, and returns null for an unknown key so
 *  template validation can reject it up front. */
export function label(locale, key) {
  const dict = DICTIONARIES[languageOf(locale)] || EN;
  return dict[key] ?? EN[key] ?? null;
}

function tag(locale, extra = "") {
  return `${locale}-u-nu-latn${extra}`;
}

export function formatMoney(amount, currency, locale = "en-US", display = "symbol") {
  try {
    // Precision comes from the engine's own currency table, never from ICU's
    // default: ICU shows PKR with 0 decimals, which would print 1,234.50 as
    // 1,235 while the calculation is exact to the paisa (found by a test).
    const digits = CURRENCY_EXPONENTS[String(currency).toUpperCase()];
    const opts = digits === undefined ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits };
    return new Intl.NumberFormat(tag(locale), { style: "currency", currency, currencyDisplay: display, ...opts }).format(amount);
  } catch {
    return `${currency} ${Number(amount).toFixed(2)}`;
  }
}

export function formatNumber(value, locale = "en-US", opts = {}) {
  try {
    return new Intl.NumberFormat(tag(locale), { maximumFractionDigits: 8, ...opts }).format(value);
  } catch {
    return String(value);
  }
}

export function formatPercent(value, locale = "en-US") {
  try {
    return new Intl.NumberFormat(tag(locale), { style: "percent", maximumFractionDigits: 4 }).format(Number(value) / 100);
  } catch {
    return `${value}%`;
  }
}

/** Dates always render in UTC so the same instant produces the same text on
 *  every host/time zone -- a requirement for reproducible documents (§24). */
export function formatDate(value, locale = "en-US", withTime = false) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  try {
    return new Intl.DateTimeFormat(tag(locale, "-ca-gregory"), withTime
      ? { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }
      : { dateStyle: "medium", timeZone: "UTC" }).format(d);
  } catch {
    return d.toISOString().slice(0, withTime ? 16 : 10);
  }
}

export function icuInfo() {
  return { node: process.versions.node, icu: process.versions.icu || null, unicode: process.versions.unicode || null };
}
