import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiQuery, ApiOkResponse } from '@nestjs/swagger';
import { Public } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { GatewayRegistry } from '../gateways/gateway.registry';

interface PaymentStatusResponse {
  found: boolean;
  status: string;
  invoice: {
    number: string;
    student: {
      firstName: string;
      lastName: string;
    };
    school: {
      name: string;
    };
    totalAmount: number;
    paidAmount: number;
    currency: string;
  };
  payment?: {
    txRef: string;
    amount: number;
    status: string;
    createdAt: string;
    succeededAt?: string;
    failureReason?: string;
    method?: string;
    gatewayReference?: string;
  };
  receipt?: {
    receiptNumber: string;
    issuedAt: string;
    pdfUrl?: string;
  };
  message: string;
  helpText?: string;
}

@ApiTags('public')
@Public()
@Controller('public/payment-status')
export class PaymentStatusController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateways: GatewayRegistry,
  ) {}

  @Get(':invoiceId')
  @ApiOperation({
    summary: 'Check payment status (parent-facing)',
    description: `
      Allows parents to check the status of their payment by providing the invoice ID.
      Useful for verifying payment after multi-attempt checkout or when dashboard shows incorrect status.
      
      This endpoint is public and does not require authentication.
    `,
  })
  @ApiQuery({
    name: 'txRef',
    required: false,
    description: 'Optional: Chapa transaction reference if known',
  })
  @ApiOkResponse({ description: 'Payment status information' })
  async checkStatus(
    @Param('invoiceId') invoiceId: string,
    @Query('txRef') txRef?: string,
  ): Promise<PaymentStatusResponse> {
    // Find the invoice
    const invoice = await this.prisma.db.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        school: { select: { name: true, code: true } },
        student: { select: { firstName: true, lastName: true } },
        payments: {
          where: txRef ? { txRef } : undefined,
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: {
            receipt: {
              select: {
                id: true,
                receiptNo: true,
                issuedAt: true,
                pdfKey: true,
              },
            },
          },
        },
      },
    });

    if (!invoice) {
      throw new NotFoundException('Invoice not found. Please check the invoice ID and try again.');
    }

    const payment = invoice.payments[0];
    const balance = invoice.totalAmount - invoice.paidAmount;

    // Base response
    const response: PaymentStatusResponse = {
      found: !!payment,
      status: invoice.status,
      invoice: {
        number: invoice.number,
        student: {
          firstName: invoice.student.firstName,
          lastName: invoice.student.lastName,
        },
        school: {
          name: invoice.school.name,
        },
        totalAmount: invoice.totalAmount,
        paidAmount: invoice.paidAmount,
        currency: invoice.currency,
      },
      message: this.getStatusMessage(invoice.status, balance, payment),
    };

    // Add payment details if found
    if (payment) {
      response.payment = {
        txRef: payment.txRef,
        amount: payment.amount,
        status: payment.status,
        createdAt: payment.createdAt.toISOString(),
        succeededAt: payment.succeededAt?.toISOString(),
        failureReason: payment.failureReason || undefined,
        method: payment.method || undefined,
        gatewayReference: payment.gatewayReference || undefined,
      };

      // Add receipt details if issued
      if (payment.receipt) {
        response.receipt = {
          receiptNumber: payment.receipt.receiptNo,
          issuedAt: payment.receipt.issuedAt.toISOString(),
          pdfUrl: payment.receipt.pdfKey
            ? `/api/receipts/${payment.receipt.id}/download`
            : undefined,
        };
      }

      // Add help text based on payment status
      response.helpText = this.getHelpText(payment.status, payment.failureReason);
    }

    return response;
  }

  @Get('by-reference/:txRef')
  @ApiOperation({
    summary: 'Check payment by transaction reference',
    description: `
      Check payment status using the Chapa transaction reference (txRef).
      Useful when parent has the transaction reference from Chapa but not the invoice ID.
    `,
  })
  @ApiOkResponse({ description: 'Payment status information' })
  async checkByReference(@Param('txRef') txRef: string): Promise<PaymentStatusResponse> {
    const payment = await this.prisma.db.payment.findUnique({
      where: { txRef },
      include: {
        invoice: {
          include: {
            school: { select: { name: true } },
            student: { select: { firstName: true, lastName: true } },
          },
        },
        receipt: {
          select: {
            id: true,
            receiptNo: true,
            issuedAt: true,
            pdfKey: true,
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException(
        'Payment not found with this reference. Please check the reference and try again.',
      );
    }

    const invoice = payment.invoice;
    const balance = invoice.totalAmount - invoice.paidAmount;

    const response: PaymentStatusResponse = {
      found: true,
      status: invoice.status,
      invoice: {
        number: invoice.number,
        student: {
          firstName: invoice.student.firstName,
          lastName: invoice.student.lastName,
        },
        school: {
          name: invoice.school.name,
        },
        totalAmount: invoice.totalAmount,
        paidAmount: invoice.paidAmount,
        currency: invoice.currency,
      },
      payment: {
        txRef: payment.txRef,
        amount: payment.amount,
        status: payment.status,
        createdAt: payment.createdAt.toISOString(),
        succeededAt: payment.succeededAt?.toISOString(),
        failureReason: payment.failureReason || undefined,
        method: payment.method || undefined,
        gatewayReference: payment.gatewayReference || undefined,
      },
      message: this.getStatusMessage(invoice.status, balance, payment),
      helpText: this.getHelpText(payment.status, payment.failureReason),
    };

    if (payment.receipt) {
      response.receipt = {
        receiptNumber: payment.receipt.receiptNo,
        issuedAt: payment.receipt.issuedAt.toISOString(),
        pdfUrl: payment.receipt.pdfKey
          ? `/api/receipts/${payment.receipt.id}/download`
          : undefined,
      };
    }

    return response;
  }

  private getStatusMessage(
    invoiceStatus: string,
    balance: number,
    payment?: { status: string; amount: number },
  ): string {
    if (invoiceStatus === 'PAID') {
      return '✅ This invoice is fully paid. Thank you!';
    }

    if (invoiceStatus === 'PARTIALLY_PAID') {
      return `⚠️ This invoice is partially paid. Remaining balance: ${balance / 100} ETB`;
    }

    if (!payment) {
      return '❓ No payment record found for this invoice yet.';
    }

    switch (payment.status) {
      case 'SUCCEEDED':
        return '✅ Payment successful! Receipt has been issued.';
      case 'PENDING':
        return '⏳ Payment is being processed. Please wait a few minutes and check again.';
      case 'FAILED':
        return '❌ Payment failed. Please try again or contact support.';
      case 'REVIEW':
        return '🔍 Payment is under review. Our team will resolve this shortly.';
      case 'REFUNDED':
        return '↩️ Payment was refunded.';
      default:
        return 'Payment status unknown. Please contact support.';
    }
  }

  private getHelpText(status: string, failureReason?: string | null): string {
    switch (status) {
      case 'PENDING':
        return 'If your payment has been pending for more than 10 minutes, our system will automatically verify it with Chapa. If you were charged but the status doesn\'t update, please contact school support with your transaction reference.';
      
      case 'FAILED':
        if (failureReason === 'gateway_reported_failed') {
          return 'This payment failed at Chapa. If you clicked "Retry" inside Chapa\'s page and the payment succeeded, our system will automatically detect it within 5 minutes. If not, please contact school support.';
        }
        return 'Payment failed. Please try again. If you were charged, please contact school support with proof of payment.';
      
      case 'REVIEW':
        return 'Your payment is under manual review. This usually happens when there\'s a discrepancy between Chapa and our records. Our team will resolve this within 24 hours. If urgent, please contact school support.';
      
      case 'SUCCEEDED':
        return 'Your payment was successful. A receipt has been sent to your registered phone number. You can download it from the link above.';
      
      default:
        return 'If you have questions about this payment, please contact school support.';
    }
  }
}
