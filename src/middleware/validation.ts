// ============================================================
// Input Validation Middleware
// ============================================================
import { Request, Response, NextFunction } from 'express';

export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
export const PHONE_REGEX = /^(\+91|91)?[6-9][0-9]{9}$/;
export const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateGSTIN(gstin: string): boolean {
  return !gstin || GSTIN_REGEX.test(gstin.toUpperCase());
}

export function validatePAN(pan: string): boolean {
  return !pan || PAN_REGEX.test(pan.toUpperCase());
}

export function validateIFSC(ifsc: string): boolean {
  return !ifsc || IFSC_REGEX.test(ifsc.toUpperCase());
}

export function validatePhone(phone: string): boolean {
  return !phone || PHONE_REGEX.test(phone.replace(/[\s-]/g, ''));
}

// Middleware factory
export function validateFields(rules: Record<string, (v: string) => boolean>, fieldNames: Record<string, string>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const errors: string[] = [];
    for (const [field, validator] of Object.entries(rules)) {
      const value = req.body[field];
      if (value && !validator(value)) {
        errors.push(`Invalid ${fieldNames[field] || field}: ${value}`);
      }
    }
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join(', ') });
    }
    next();
  };
}

// Common validators
export const vendorValidation = validateFields(
  { gstin: validateGSTIN, pan: validatePAN, ifsc: validateIFSC, phone: validatePhone },
  { gstin: 'GSTIN', pan: 'PAN', ifsc: 'IFSC Code', phone: 'Phone number' }
);

export const customerValidation = validateFields(
  { gstin: validateGSTIN, pan: validatePAN, phone: validatePhone },
  { gstin: 'GSTIN', pan: 'PAN', phone: 'Phone number' }
);

export const employeeValidation = validateFields(
  { pan: validatePAN, phone: validatePhone, ifsc: validateIFSC },
  { pan: 'PAN', phone: 'Phone number', ifsc: 'IFSC Code' }
);
