// This code sets up a simple Express server that talks to Stripe to create a checkout session
// and also creates orders in Printful after a successful payment.
// We add console.log statements (debugging) to see what's going on and help fix problems.

const express = require('express');         
const axios = require('axios');             
const cors = require('cors');               
const dotenv = require('dotenv');           
const stripe = require('stripe');           

dotenv.config();                            
const app = express();                      
const PORT = process.env.PORT || 5000;      

const stripeClient = stripe(process.env.STRIPE_SECRET_KEY); 
console.log("Stripe secret key present:", Boolean(process.env.STRIPE_SECRET_KEY));

const PRINTFUL_API_KEY = process.env.PRINTFUL_API_KEY;
console.log("Printful API key present:", Boolean(PRINTFUL_API_KEY));

app.use(cors());

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
console.log("Stripe Webhook Secret present:", Boolean(endpointSecret));

// Webhook must be defined before express.json()
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripeClient.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log('Webhook Verified:', event);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('Payment successful:', session);

      // Get line items
      const lineItems = await stripeClient.checkout.sessions.listLineItems(session.id, { limit: 100 });
      console.log('Line Items from Stripe:', lineItems.data);

      // Extract variant_id from price.metadata
      const printfulItems = lineItems.data.map((item) => {
        const variantId = item.price.metadata.variant_id;
        return {
          variant_id: parseInt(variantId, 10),
          quantity: item.quantity,
        };
      });

      const { customer_details } = session;
      const recipient = {
        name: customer_details.name || 'No Name Provided',
        address1: customer_details.address.line1 || '',
        address2: customer_details.address.line2 || '',
        city: customer_details.address.city || '',
        state_code: customer_details.address.state || '',
        country_code: customer_details.address.country || 'US',
        zip: customer_details.address.postal_code || ''
      };

      console.log('Creating Printful order with items:', printfulItems);
      console.log('Recipient:', recipient);

      try {
        const printfulResponse = await axios.post(
          'https://api.printful.com/orders',
          {
            recipient,
            items: printfulItems,
            confirm: 1 // Confirm the order immediately
          },
          {
            headers: { Authorization: `Bearer ${PRINTFUL_API_KEY}` }
          }
        );

        console.log('Printful order created:', printfulResponse.data);
      } catch (error) {
        console.error('Error creating Printful order:', error.message, error.response?.data);
      }
    }

    res.status(200).send('Webhook received!');
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// After webhook, now we can use JSON parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.send('Welcome to the DadHatHub API!');
});

app.get('/api/products', async (req, res) => {
  try {
    const response = await axios.get('https://api.printful.com/store/products', {
      headers: { Authorization: `Bearer ${PRINTFUL_API_KEY}` },
    });

    console.log('Number of products fetched:', response.data.result.length);

    const detailedProducts = await Promise.all(
      response.data.result.map(async (product) => {
        const detailsResponse = await axios.get(
          `https://api.printful.com/store/products/${product.id}`,
          {
            headers: { Authorization: `Bearer ${PRINTFUL_API_KEY}` },
          }
        );

        const details = detailsResponse.data.result;
        const price = details.sync_variants?.[0]?.retail_price
          ? parseFloat(details.sync_variants[0].retail_price) * 100
          : 0;

        const mockupImage =
          details.sync_variants[0]?.files.find((file) => file.type === 'preview')
            ?.preview_url || product.thumbnail_url;

        return {
          id: product.id,
          name: product.name || 'No name available',
          thumbnail_url: mockupImage || 'default_image_url',
          price,
          variant_id: details.sync_variants?.[0]?.id || null,
        };
      })
    );

    res.status(200).json({ products: detailedProducts });
  } catch (error) {
    console.error('Error fetching products from Printful:', error.message);
    res.status(500).json({ error: 'Failed to fetch products.' });
  }
});

app.get('/api/products/:id', async (req, res) => {
  const productId = req.params.id;
  console.log(`Fetching product with ID: ${productId}`);

  try {
    const response = await axios.get(`https://api.printful.com/store/products/${productId}`, {
      headers: { Authorization: `Bearer ${PRINTFUL_API_KEY}` },
    });

    const product = response.data.result;

    const productDetails = {
      id: product.sync_product.id,
      name: product.sync_product.name,
      description: product.sync_product.description || 'No description available',
      thumbnail_url: product.sync_product.thumbnail_url,
      variants: product.sync_variants.map((variant) => ({
        id: variant.id,
        name: variant.name,
        price: parseFloat(variant.retail_price) * 100,
        thumbnail_url: variant.files?.find((file) => file.type === 'preview')?.preview_url || null,
      })),
    };

    res.status(200).json(productDetails);
  } catch (error) {
    console.error(`Error fetching product with ID ${productId}:`, error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/stripe/create-checkout-session', async (req, res) => {
  const { cart, customerInfo } = req.body;

  console.log("Received cart from frontend:", cart);
  console.log("Received customerInfo from frontend:", customerInfo);

  try {
    const lineItems = cart.map((item) => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          images: [item.thumbnail_url],
        },
        unit_amount: item.price,
        metadata: {
          variant_id: String(item.variant_id),
          product_id: String(item.id),
        },
      },
      quantity: item.quantity,
    }));

    console.log("Line Items for Stripe:", JSON.stringify(lineItems, null, 2));

    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      customer_email: customerInfo.email,
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
      shipping_address_collection: { allowed_countries: ['US', 'CA'] },
      billing_address_collection: 'required',
    });

    console.log("Created Stripe session:", session);

    res.status(200).json({ id: session.id });
  } catch (error) {
    console.error('Stripe Checkout Session Error:', error);
    res.status(500).json({
      error: 'Failed to create Stripe session.',
      details: error.message,
    });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
