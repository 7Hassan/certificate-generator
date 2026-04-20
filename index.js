//! Error uncaught Exception
process.on('uncaughtException', (err) => {
  console.error('⛔ ' + err.name, err.message, err.stack)
  process.exit(1)
})

const app = require('./app')

const port = process.env.PORT || 8000
                                                                                              
const server = app.listen(port, () => console.log(`✅ app listening on port ${port}`))

//! Error with connection with mongo                
process.on('unhandledRejection', (err) => {
  console.error('🚨 ' + err.name, err.message)
  server.close(() => process.exit(1))
})
