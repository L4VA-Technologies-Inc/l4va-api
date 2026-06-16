import * as yup from 'yup';

export const buyOptionSchema = yup.object({
  assetId: yup.string().required().min(56, 'Asset ID must be at least 56 characters'),
  assetName: yup.string().required(),
  sellType: yup.string().required(),
  market: yup.string().required(),
  price: yup
    .number()
    .transform((value, originalValue) => {
      const parsed = Number(originalValue);
      return Number.isNaN(parsed) ? undefined : parsed;
    })
    .typeError('Price must be a number')
    .min(5, 'Minimum price is 5 ADA')
    .required(),
  exec: yup.string().required(),
  id: yup.number().required(),
});

export const transactionOptionSchema = yup.object({
  assetName: yup.string().required(),
  duration: yup.string().when('method', {
    is: 'GTC',
    then: schema => schema.notRequired().nullable(),
    otherwise: schema => schema.required(),
  }),
  price: yup.string().when('sellType', {
    is: 'Market',
    then: schema => schema.notRequired().nullable(),
    otherwise: schema => schema.required(),
  }),
  method: yup.string().required(),
  sellType: yup.string().required(),
  exec: yup.string().required(),
  id: yup.number().required(),
  market: yup.string().required(),
});
